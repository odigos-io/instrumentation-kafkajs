
export interface Partition {
  partition: number;
  firstSequence: number;
  messages: Array<any>;
}

export interface Topic {
  topic: string;
  partitions: Array<Partition>;
}

export type TopicData = Array<Topic>;

// Broker fetch response is the type of the response object returned by the fetch method of the KafkaJS Broker class
// It contains many other fields, but we are only listing the ones we are interested in
export interface BrokerFetchResponse {
    responses: Array<{
        partitions: Array<{
            messages: Array<{}>
        }>
    }>
};
