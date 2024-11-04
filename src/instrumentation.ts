import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from "@opentelemetry/instrumentation";
import { KafkaJsInstrumentationConfig } from "./types";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version";
import { TopicData } from "./internal-types";
import { SpanKind } from "@opentelemetry/api";
import { ATTR_SERVER_ADDRESS } from "@opentelemetry/semantic-conventions";
import {
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_DESTINATION_PARTITION_ID,
  ATTR_MESSAGING_OPERATION_NAME,
  ATTR_MESSAGING_SYSTEM,
  MESSAGING_SYSTEM_VALUE_KAFKA,
} from "@opentelemetry/semantic-conventions/incubating";

export class KafkaJsInstrumentation extends InstrumentationBase<KafkaJsInstrumentationConfig> {
  constructor(config: KafkaJsInstrumentationConfig = {}) {
    super(PACKAGE_NAME, PACKAGE_VERSION, config);
  }

  protected init() {
    const brokerFileInstrumentation = new InstrumentationNodeModuleFile(
      "kafkajs/src/broker/index.js",
      [">=0.1.0 <3"],
      (moduleExports) => {
        this._wrap(
          moduleExports.prototype,
          "produce",
          this.getBrokerProducePatch()
        );
        return moduleExports;
      },
      (moduleExports) => {
        console.log("moduleExports", moduleExports);
      }
    );

    const module = new InstrumentationNodeModuleDefinition(
      "kafkajs",
      [">=0.1.0 <3"],
      undefined, // only patch internal files, not the main module
      undefined, // only patch internal files, not the main module
      [brokerFileInstrumentation]
    );
    return module;
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
            return p.messages.map((m) => {
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
                    [ATTR_SERVER_ADDRESS]: brokerAddress,
                  },
                }
              );
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
}
