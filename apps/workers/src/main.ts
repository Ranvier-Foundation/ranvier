// Entry point for scheduled jobs. The daily chain health check (./chain-health.ts) is
// scheduled here once its data sources (DefiLlama, RPC probes, provider coverage) and
// the Postgres-backed listing store are built.
console.log('workers: no jobs scheduled yet');
