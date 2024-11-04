
export interface Partition {
    partition: number;
    firstSequence: number;
    messages: Array<any>;
}

export interface Topic {
    topic: string;
    partitions: Array<Partition>;
};

export type TopicData = Array<Topic>;