/** The open local host: one person, their own computer, their own agent. */
export { createLocalHost, LOCAL_RUNS_WHERE, type LocalHost, type LocalHostOptions } from "./host";
export { MemoryScriptLibrary } from "./library";
export { remoteModelServer, startInMemoryModelServer, type LocalModelServer } from "./model-server";
export { LOCAL_AGENT_NAME, localCaller, localModelAccess, READ_ONLY_REFUSAL, type LocalModelAccessOptions } from "./models";
export { parseArgs, startCli, starterModel, USAGE, type CliOptions, type LocalPacksFactory, type Started } from "../cli";
export { serveHttp, serveStdio, type HttpOptions, type HttpServing } from "../transports";
