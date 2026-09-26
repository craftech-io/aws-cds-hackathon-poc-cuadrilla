// One JSON line per request of the mock, correlated by the Function URL request id. Only the fields
// below are accepted, and none of them can hold personal data: operators, work order numbers, event
// ids and codes. Bodies, installers and windows never reach a log line.
export interface MockLogFields {
  readonly requestId?: string;
  readonly route?: string;
  readonly method?: string;
  readonly statusCode?: number;
  readonly ispId?: string;
  readonly workOrderNumber?: string;
  readonly eventId?: string;
  readonly replayed?: boolean;
  readonly code?: string;
  readonly reason?: string;
  readonly errorName?: string;
  readonly durationMs?: number;
}

export type LogSink = (line: string) => void;

export interface MockLogger {
  info(message: string, fields?: MockLogFields): void;
  error(message: string, fields?: MockLogFields): void;
}

export function createLogger(sink: LogSink = (line) => console.log(line), now: () => Date = () => new Date()): MockLogger {
  const write = (level: "info" | "error", message: string, fields: MockLogFields = {}) =>
    sink(JSON.stringify({ level, time: now().toISOString(), service: "dispatch-mock", message, ...fields }));
  return {
    info: (message, fields) => write("info", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
