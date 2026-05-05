const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildLaunchdConfig,
  buildPlist,
  escapeXml,
} = require("../scripts/launchd-service");

test("launchd service plist points at shared-start with claudecode runtime", () => {
  const config = buildLaunchdConfig({
    label: "com.example.mossbridge",
    runtime: "claudecode",
    node: "/opt/node",
  });
  const plist = buildPlist(config);

  assert.match(plist, /<key>Label<\/key>\n\s+<string>com\.example\.mossbridge<\/string>/);
  assert.match(plist, /<string>\/opt\/node<\/string>/);
  assert.match(plist, /scripts\/shared-start\.js<\/string>/);
  assert.match(plist, /<key>ASHERIEBRIDGE_RUNTIME<\/key>\n\s+<string>claudecode<\/string>/);
  assert.match(plist, /<key>ASHERIEBRIDGE_SHARED_SUPERVISE<\/key>\n\s+<string>1<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n\s+<true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\n\s+<false\/>/);
});

test("launchd service plist escapes XML-sensitive values", () => {
  assert.equal(escapeXml("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
});
