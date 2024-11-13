import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  isWrapped,
} from "@opentelemetry/instrumentation";
import { KafkaJsInstrumentationConfig } from "./types";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version";
import { BrokerFetchResponse, TopicData } from "./internal-types";
import {
  Context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  context,
  trace,
  Link,
  INVALID_SPAN_CONTEXT,
} from "@opentelemetry/api";
import { ATTR_SERVER_ADDRESS } from "@opentelemetry/semantic-conventions";
import {
  ATTR_MESSAGING_CONSUMER_GROUP_NAME,
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_DESTINATION_PARTITION_ID,
  ATTR_MESSAGING_KAFKA_MESSAGE_KEY,
  ATTR_MESSAGING_KAFKA_OFFSET,
  ATTR_MESSAGING_OPERATION_NAME,
  ATTR_MESSAGING_SYSTEM,
  MESSAGING_SYSTEM_VALUE_KAFKA,
} from "@opentelemetry/semantic-conventions/incubating";
import type {
  EachMessageHandler,
  EachBatchHandler,
  KafkaMessage,
  Batch,
  Message,
} from "kafkajs";
import { bufferTextMapGetter } from "./propagator";
import { createOrAddMessageAttributes, getMessagesAttributes, PatchedKafkaMessage } from "./message-attributes";

export class KafkaJsInstrumentation extends InstrumentationBase<KafkaJsInstrumentationConfig> {
  constructor(config: KafkaJsInstrumentationConfig = {}) {
    super(PACKAGE_NAME, PACKAGE_VERSION, config);
  }

  protected init() {
    const instrumentation = this;

    const brokerFileInstrumentation = new InstrumentationNodeModuleFile(
      "kafkajs/src/broker/index.js",
      [">=0.1.0 <3"],
      (moduleExports) => {
        this._wrap(
          moduleExports.prototype,
          "produce",
          this.getBrokerProducePatch()
        );
        this._wrap(
          moduleExports.prototype,
          "fetch",
          this.getBrokerFetchPatch()
        );
        return moduleExports;
      },
      (moduleExports) => {
        // TODO: unpatch
      }
    );

    const consumerFileInstrumentation = new InstrumentationNodeModuleFile(
      "kafkajs/src/consumer/index.js",
      [">=0.1.0 <3"],
      (moduleExports) => {
        if (typeof moduleExports !== "function") {
          return moduleExports;
        }

        // the module export is a function, it is invoked to create a new instance of the consumer
        // we wrap the 'run' method of the consumer instance after it is created
        return function (this: any) {
          const res = moduleExports.apply(this, arguments);
          instrumentation._wrap(
            res,
            "run",
            instrumentation.getConsumerRunPatch()
          );
          return res;
        };
      },
      (moduleExports) => {
        // TODO: unpatch
      }
    );

    const consumerGroupFileInstrumentation = new InstrumentationNodeModuleFile(
      "kafkajs/src/consumer/consumerGroup.js",
      [">=0.1.0 <3"],
      (moduleExports) => {
        this._wrap(
          moduleExports.prototype,
          "fetch",
          this.getConsumerGroupFetchPatch()
        );
        return moduleExports;
      },
      (moduleExports) => {
        // TODO: unpatch
      }
    );

    const module = new InstrumentationNodeModuleDefinition(
      "kafkajs",
      [">=0.1.0 <3"],
      undefined, // only patch internal files, not the main module
      undefined, // only patch internal files, not the main module
      [
        brokerFileInstrumentation,
        consumerFileInstrumentation,
        consumerGroupFileInstrumentation,
      ]
    );
    return module;
  }

  private getConsumerGroupFetchPatch() {
    // const instrumentation = this;
    return (original: any) => {
      return function fetch(this: any) {
        const additionalAttributes = {
          [ATTR_MESSAGING_CONSUMER_GROUP_NAME]: this.groupId,
        };
        const response = original.apply(this, arguments);
        return response.then((result: Batch[]) => {
          result.forEach((batch) => {
            batch.messages?.forEach((message) => {
              createOrAddMessageAttributes(message as PatchedKafkaMessage, additionalAttributes);
            });
          });
          return result;
        });
      };
    };
  }

  private getBrokerProducePatch() {
    const instrumentation = this;
    return (original: any) => {
      return function produce(this: any, produceArgs: any) {
        const brokerAddress = this.brokerAddress;
        const topicData: TopicData = produceArgs.topicData;
        const spans = topicData.flatMap((t) => {
          const topic = t.topic;
          return t.partitions.flatMap((p) => {
            const partition = p.partition;
            return p.messages.map((m: Message) => {
              const spanName = `produce ${topic}`;
              const singleMessageSpan = instrumentation.tracer.startSpan(
                spanName,
                {
                  kind: SpanKind.PRODUCER,
                  attributes: {
                    [ATTR_MESSAGING_SYSTEM]: MESSAGING_SYSTEM_VALUE_KAFKA,
                    [ATTR_MESSAGING_OPERATION_NAME]: "produce",
                    [ATTR_MESSAGING_DESTINATION_NAME]: topic,
                    [ATTR_MESSAGING_DESTINATION_PARTITION_ID]: partition,
                    [ATTR_MESSAGING_KAFKA_MESSAGE_KEY]:
                      m.key?.toString("base64"),
                    [ATTR_SERVER_ADDRESS]: brokerAddress,
                  },
                }
              );
              // record the span context in each message headers for context propagation to downstream spans
              m.headers = m.headers ?? {}; // NOTICE - changed via side effect
              propagation.inject(
                trace.setSpan(context.active(), singleMessageSpan),
                m.headers
              );

              m.headers = { ...m.headers };
              return singleMessageSpan;
            });
          });
        });

        try {
          return original.apply(this, arguments);
        } finally {
          spans.forEach((span) => {
            span.end();
          });
        }
      };
    };
  }

  private getBrokerFetchPatch() {
    return (original: any) => {
      return function fetch(this: any, produceArgs: any) {
        const brokerAddress = this.brokerAddress;
        const additionalAttributes = {
          [ATTR_SERVER_ADDRESS]: brokerAddress,
        };

        const response = original.apply(this, arguments);
        return response.then((result: BrokerFetchResponse) => {
          result.responses?.forEach(({ partitions }) => {
            partitions?.forEach(({ messages }) => {
              messages?.forEach((message) => {
                createOrAddMessageAttributes(message as PatchedKafkaMessage, additionalAttributes);
              });
            });
          });
          return result;
        });
      };
    };
  }

  private getConsumerRunPatch() {
    const instrumentation = this;
    return (original: any) => {
      return function run(this: any, runOptions: any) {
        if (runOptions?.eachMessage) {
          if (isWrapped(runOptions.eachMessage)) {
            instrumentation._unwrap(runOptions, "eachMessage");
          }
          instrumentation._wrap(
            runOptions,
            "eachMessage",
            instrumentation.getConsumerEachMessagePatch()
          );
        }
        if (runOptions?.eachBatch) {
          if (isWrapped(runOptions.eachBatch)) {
            instrumentation._unwrap(runOptions, "eachBatch");
          }
          instrumentation._wrap(
            runOptions,
            "eachBatch",
            instrumentation.getConsumerEachBatchPatch()
          );
        }
        return original.call(this, runOptions);
      };
    };
  }

  private getConsumerEachBatchPatch() {
    const instrumentation = this;
    return (original: EachBatchHandler) => {
      return function eachBatch(
        this: unknown,
        ...args: Parameters<EachBatchHandler>
      ): Promise<void> {
        const payload = args[0];
        const { batch } = payload;
        const { topic, partition } = batch;
        // instrumentation records broker info and consumer group per message,
        // all messages in a batch comes from the same broker and consumer group,
        // we can use the value from any message to populate it once for the batch span.
        const additionalAttributes = getMessagesAttributes(batch.messages[0] as PatchedKafkaMessage) ?? {};

        // record each message with proper context as link
        const links = batch.messages.map((message: KafkaMessage): Link => {
          const messageContext: Context = propagation.extract(
            ROOT_CONTEXT,
            message.headers,
            bufferTextMapGetter
          );
          return {
            context:
              trace.getSpanContext(messageContext) ?? INVALID_SPAN_CONTEXT,
            attributes: {
              [ATTR_MESSAGING_KAFKA_OFFSET]: message.offset,
              // key can be byte array which is not string-representable.
              // choosing safe option to encode data as hex.
              // TODO: expose instrumentation config option to collect this value as string (utf-8) or base64?
              [ATTR_MESSAGING_KAFKA_MESSAGE_KEY]: message.key?.toString("base64"),
              // TODO: here we will inject the payload with a hook in the future.
            },
          };
        });

        const span = instrumentation.tracer.startSpan(
          `consume ${topic}`,
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              [ATTR_MESSAGING_SYSTEM]: MESSAGING_SYSTEM_VALUE_KAFKA,
              [ATTR_MESSAGING_OPERATION_NAME]: "consume",
              [ATTR_MESSAGING_DESTINATION_NAME]: topic,
              [ATTR_MESSAGING_DESTINATION_PARTITION_ID]: partition,
              ...additionalAttributes,
            },
            links,
          }
          // notice: we do not specify the parent context here intentionally.
          // this is a batch operation that may contain messages from different parents (fan-in).
          // the consume operation here represents the hand-off of the batch to the application.
          // the individual messages are recorded as span links, each with their own ...
        );

        const eachBatchPromise = context.with(
          trace.setSpan(context.active(), span),
          original,
          this,
          ...args
        );
        return eachBatchPromise.finally(() => {
          span.end();
        });
      };
    };
  }

  private getConsumerEachMessagePatch() {
    const instrumentation = this;
    return (original: EachMessageHandler) => {
      return function eachMessage(
        this: unknown,
        ...args: Parameters<EachMessageHandler>
      ): Promise<void> {
        const payload = args[0];
        const additionalAttributes = getMessagesAttributes(payload.message as PatchedKafkaMessage) ?? {};
        const propagatedContext: Context = propagation.extract(
          ROOT_CONTEXT,
          payload.message.headers,
          bufferTextMapGetter
        );
        const span = instrumentation.tracer.startSpan(
          `consume ${payload.topic}`,
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              [ATTR_MESSAGING_SYSTEM]: MESSAGING_SYSTEM_VALUE_KAFKA,
              [ATTR_MESSAGING_OPERATION_NAME]: "consume",
              [ATTR_MESSAGING_DESTINATION_NAME]: payload.topic,
              [ATTR_MESSAGING_KAFKA_MESSAGE_KEY]: payload.message.key?.toString("base64"),
              [ATTR_MESSAGING_DESTINATION_PARTITION_ID]: payload.partition,
              [ATTR_MESSAGING_KAFKA_OFFSET]: payload.message.offset,
              ...additionalAttributes,
            },
          },
          propagatedContext
        );

        const eachMessagePromise = context.with(
          trace.setSpan(propagatedContext, span),
          original,
          this,
          ...args
        );
        return eachMessagePromise.finally(() => {
          span.end();
        });
      };
    };
  }
}
