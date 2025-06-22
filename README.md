# instrumentation-kafkajs
Nodejs OpenTelemetry instrumentation for kafkajs package in nodejs

## Background

This instrumentation is written be [Odigos team](https://github.com/odigos-io/odigos) to extend the [kafkajs instrumentation in contrib](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/plugins/node/instrumentation-kafkajs) with few additional attributes and semantic improvements.

It is planed to be ported to upstream some time in future once it's more mature. in the meantime, it allows us to move fast, experiment and iterate on the new features.

## Stability

This package is a work in progress and can introduce breaking changes in future versions. Anyone is welcome to use it, but be aware from changes in attribute names and semantics, spans structure, etc.

### Supported versions

- [`kafkajs`](https://www.npmjs.com/package/kafkajs) versions `>=0.3.0 <3`

## Usage

TODO: this is here for odigos automatic docs creation. 
