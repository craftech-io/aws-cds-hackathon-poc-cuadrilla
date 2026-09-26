// The capture pipeline reads the landing's media manifest with the page's own schema
// (packages/web/src/views/landing/media.ts), whose fetch helper (packages/web/src/lib/http.ts) is
// written for the browser. This program is Node's (no DOM library): the one browser name that module
// uses and Node's types lack, with the browser's own definition.
type RequestInfo = Request | string;
