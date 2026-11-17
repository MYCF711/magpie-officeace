process.env.MAGPIE_DSML_OFF = "1"
import test from "node:test"
import assert from "node:assert/strict"
import { _internal } from "../src/codearts/index.mjs"

const { dsmlNameFix, fixDsmlNames, antmlToDsml, toolCallFnToDsml, xmlCallToDsml, kimiCallToDsml, bareParamsToDsml, holdUnfinishedCall, flattenToolExchange, prepareChatBody } = _internal

/** Tools with schemas, for the call shape that names its tool only by its arguments. */
const offeredWith = (spec) => ({
  tools: Object.entries(spec).map(([name, keys]) => ({
    type: "function",
    function: {
      name,
      parameters: { type: "object", properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])) },
    },
  })),
})

/** The tool set an agent like Claude Code offers, and its own spelling of it. */
const offered = (names) => ({ tools: names.map((name) => ({ type: "function", function: { name } })) })

test("a DSML invoke written with another case or a common alias gets the offered name", () => {
  const fix = dsmlNameFix(offered(["Bash", "Write", "Read", "Edit"]))
  const cases = [
    ['<｜DSML｜invoke name="bash">', '<｜DSML｜invoke name="Bash">'],
    ["<｜DSML｜invoke name=\"write_file\">", '<｜DSML｜invoke name="Write">'],
    ["<｜DSML｜invoke name=\"read_file\">", '<｜DSML｜invoke name="Read">'],
    ["<｜DSML｜invoke name=\"edit_file\">", '<｜DSML｜invoke name="Edit">'],
  ]
  for (const [before, after] of cases) {
    assert.equal(fixDsmlNames(before, fix), after)
  }
})

test("a name the request never offered is left byte for byte", () => {
  const fix = dsmlNameFix(offered(["Write"]))
  const text = '<｜DSML｜invoke name="teleport">'
  assert.equal(fixDsmlNames(text, fix), text)
})

test("ordinary prose is never read", () => {
  const fix = dsmlNameFix(offered(["Bash"]))
  const prose = 'The shell said: invoke name="bash" is not a thing here.'
  assert.equal(fixDsmlNames(prose, fix), prose)
})

test("an escaped tag, as SSE carries it, is repaired too", () => {
  const fix = dsmlNameFix(offered(["Bash"]))
  assert.equal(fixDsmlNames('<｜DSML｜invoke name=\\"bash\\">', fix), '<｜DSML｜invoke name=\\"Bash\\">')
})

test("no tools offered: nothing to resolve, nothing changed", () => {
  assert.equal(dsmlNameFix({ messages: [] }), null)
  assert.equal(dsmlNameFix({ tools: [] }), null)
})

test("an <antml:invoke> carrying JSON becomes the markup magpie rescues", () => {
  const fix = dsmlNameFix(offered(["Write"]))
  const text = '<antml:invoke>{"tool_name":"write","parameters":{"file_path":"/tmp/a.txt","content":"hi"}}</antml:invoke>'
  assert.equal(
    antmlToDsml(text, fix),
    '<｜DSML｜ invoke name="Write"><｜DSML｜ parameter name="file_path" string="true">/tmp/a.txt</｜DSML｜ parameter><｜DSML｜ parameter name="content" string="true">hi</｜DSML｜ parameter></｜DSML｜ invoke>',
  )
})

test("a <tool_call> written as a function invocation becomes the same markup", () => {
  const fix = dsmlNameFix(offered(["Bash"]))
  const text = '<tool_call>functions.exec({"cmd":"Get-ChildItem"})</tool_call>'
  assert.equal(
    toolCallFnToDsml(text, fix),
    '<｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="cmd" string="true">Get-ChildItem</｜DSML｜ parameter></｜DSML｜ invoke>',
  )
})

test("markup that cannot be read is passed on untouched", () => {
  const fix = dsmlNameFix(offered(["Write", "Bash"]))
  assert.equal(antmlToDsml("<antml:invoke>{oops}</antml:invoke>", fix), "<antml:invoke>{oops}</antml:invoke>")
  assert.equal(toolCallFnToDsml("<tool_call>functions.exec(oops)</tool_call>", fix), "<tool_call>functions.exec(oops)</tool_call>")
  assert.equal(toolCallFnToDsml('<tool_call>functions.teleport({"x":1})</tool_call>', fix), '<tool_call>functions.teleport({"x":1})</tool_call>')
})

test("an MCP tool written by its tail resolves to the one the request offered", () => {
  const fix = dsmlNameFix(offered(["mcp__terminal__read_terminal", "mcp__terminal__run_in_terminal"]))
  assert.equal(fix("read_terminal"), "mcp__terminal__read_terminal")
  assert.equal(fix("run_in_terminal"), "mcp__terminal__run_in_terminal")
})

test("a tail two offered tools share is not guessed between", () => {
  const fix = dsmlNameFix(offered(["mcp__a__read", "mcp__b__read"]))
  assert.equal(fix("read"), null)
})

test("an unknown tail still resolves to nothing", () => {
  const fix = dsmlNameFix(offered(["mcp__terminal__read_terminal"]))
  assert.equal(fix("write_terminal"), null)
})

test("an XML call whose outer tag names an offered tool becomes the rescued markup", () => {
  const fix = dsmlNameFix(offered(["Edit"]))
  const text = "<Edit><file_path>src/server.js</file_path><old_string>a</old_string><new_string>b</new_string></Edit>"
  assert.equal(
    xmlCallToDsml(text, fix),
    '<｜DSML｜ invoke name="Edit"><｜DSML｜ parameter name="file_path" string="true">src/server.js</｜DSML｜ parameter><｜DSML｜ parameter name="old_string" string="true">a</｜DSML｜ parameter><｜DSML｜ parameter name="new_string" string="true">b</｜DSML｜ parameter></｜DSML｜ invoke>',
  )
})

test("an XML block that names no offered tool is left alone", () => {
  const fix = dsmlNameFix(offered(["Edit"]))
  const text = "<config><host>localhost</host></config>"
  assert.equal(xmlCallToDsml(text, fix), text)
})

test("an XML block with no child fields is left alone", () => {
  const fix = dsmlNameFix(offered(["Edit"]))
  const text = "<Edit>just prose</Edit>"
  assert.equal(xmlCallToDsml(text, fix), text)
})

test("a shortened name matches the one offered tool it prefixes", () => {
  const fix = dsmlNameFix(offered(["exec_command", "apply_patch"]))
  assert.equal(fix("exec"), "exec_command")
  assert.equal(fix("apply"), "apply_patch")
})

test("a prefix two offered tools share is not guessed between", () => {
  const fix = dsmlNameFix(offered(["list_mcp_resources", "list_mcp_resource_templates"]))
  assert.equal(fix("list"), null)
})

test("a one- or two-letter drift is too loose to read as a prefix", () => {
  const fix = dsmlNameFix(offered(["exec_command"]))
  assert.equal(fix("ex"), null)
})

// ---- Kimi's native <|open|> markup -------------------------------------------

test("a Kimi call becomes the markup magpie rescues, typed args kept as JSON", () => {
  const fix = dsmlNameFix(offered(["Grep"]))
  const text =
    '<|open|>tools<|sep|><|open|>call tool="Grep" index="1"<|sep|>' +
    '<|open|>argument key="pattern" type="string"<|sep|>(?i)kimi<|close|>argument<|sep|>' +
    '<|open|>argument key="head_limit" type="number"<|sep|>60<|close|>argument<|sep|>' +
    '<|close|>call<|sep|><|close|>tools<|sep|>'
  assert.equal(
    kimiCallToDsml(text, fix),
    '<|open|>tools<|sep|><｜DSML｜ invoke name="Grep"><｜DSML｜ parameter name="pattern">(?i)kimi</｜DSML｜ parameter><｜DSML｜ parameter name="head_limit">60</｜DSML｜ parameter></｜DSML｜ invoke><|close|>tools<|sep|>',
  )
})

test("a Kimi call with string=\"true\" keeps the value verbatim, not JSON-decoded", () => {
  const fix = dsmlNameFix(offered(["Bash"]))
  const text = '<|open|>call tool="Bash"<|sep|><|open|>argument key="command" string="true"<|sep|>echo "123"<|close|>argument<|sep|><|close|>call<|sep|>'
  assert.equal(
    kimiCallToDsml(text, fix),
    '<｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command" string="true">echo "123"</｜DSML｜ parameter></｜DSML｜ invoke>',
  )
})

test("a name the request never offered is left as the text it is", () => {
  const fix = dsmlNameFix(offered(["Write"]))
  const text = '<|open|>call tool="Teleport"<|sep|><|open|>argument key="x" type="number"<|sep|>1<|close|>argument<|sep|><|close|>call<|sep|>'
  assert.equal(kimiCallToDsml(text, fix), text)
})

test("a call with no arguments at all is left alone", () => {
  const fix = dsmlNameFix(offered(["Grep"]))
  const text = '<|open|>call tool="Grep" index="1"<|sep|><|close|>call<|sep|>'
  assert.equal(kimiCallToDsml(text, fix), text)
})

test("an argument that never closes means the call is not converted", () => {
  const fix = dsmlNameFix(offered(["Grep"]))
  const text = '<|open|>call tool="Grep"<|sep|><|open|>argument key="pattern" type="string"<|sep|>kimi<|close|>call<|sep|>'
  assert.equal(kimiCallToDsml(text, fix), text)
})

test("a call inside a fenced code block is never run as a tool", () => {
  const fix = dsmlNameFix(offered(["Bash"]))
  const inner = '<|open|>call tool="Bash"<|sep|><|open|>argument key="command" type="string"<|sep|>rm -rf /tmp/demo<|close|>argument<|sep|><|close|>call<|sep|>'
  const text = 'Here is an example:\n```\n' + inner + '\n```\n'
  assert.equal(kimiCallToDsml(text, fix), text)
})

test("a call before the fence opens and one inside it are told apart", () => {
  const fix = dsmlNameFix(offered(["Bash"]))
  const call = '<|open|>call tool="Bash"<|sep|><|open|>argument key="command" type="string"<|sep|>ls<|close|>argument<|sep|><|close|>call<|sep|>'
  const text = call + '\n```\n' + call + '\n```\n'
  const out = kimiCallToDsml(text, fix)
  assert.ok(out.includes('<｜DSML｜ invoke name="Bash">'))
  assert.ok(out.includes('```\n' + call))
})

test("two calls in one tools block both convert", () => {
  const fix = dsmlNameFix(offered(["Grep", "Read"]))
  const text =
    '<|open|>call tool="Grep" index="1"<|sep|><|open|>argument key="pattern" type="string"<|sep|>kimi<|close|>argument<|sep|><|close|>call<|sep|>' +
    '<|open|>call tool="Read" index="2"<|sep|><|open|>argument key="file_path" type="string"<|sep|>src/a.js<|close|>argument<|sep|><|close|>call<|sep|>'
  const out = kimiCallToDsml(text, fix)
  assert.ok(out.includes('<｜DSML｜ invoke name="Grep">'))
  assert.ok(out.includes('<｜DSML｜ invoke name="Read">'))
  assert.ok(!out.includes('<|open|>'))
})

test("escaped quotes, as an SSE snapshot carries them, are read too", () => {
  const fix = dsmlNameFix(offered(["Grep"]))
  const text = '<|open|>call tool=\\"Grep\\"<|sep|><|open|>argument key=\\"pattern\\" type=\\"string\\"<|sep|>kimi<|close|>argument<|sep|><|close|>call<|sep|>'
  assert.equal(
    kimiCallToDsml(text, fix),
    '<｜DSML｜ invoke name="Grep"><｜DSML｜ parameter name="pattern">kimi</｜DSML｜ parameter></｜DSML｜ invoke>',
  )
})

test("an argument value that mentions <|open|> does not break its attrs", () => {
  const fix = dsmlNameFix(offered(["Bash"]))
  const text = '<|open|>call tool="Bash"<|sep|><|open|>argument key="command" type="string"<|sep|>echo <|open|>literal<|close|>argument<|sep|><|close|>call<|sep|>'
  assert.equal(
    kimiCallToDsml(text, fix),
    '<｜DSML｜ invoke name="Bash"><｜DSML｜ parameter name="command">echo <|open|>literal</｜DSML｜ parameter></｜DSML｜ invoke>',
  )
})

// ---- flattenToolExchange: tool exchange as text for Kimi ----------------------

test("an assistant's calls and a tool result become text", () => {
  const body = {
    messages: [
      { role: "user", content: "read src/server.js" },
      {
        role: "assistant",
        content: "Let me read it.",
        tool_calls: [
          { id: "call_text_1", type: "function", function: { name: "Read", arguments: '{"file_path":"src/server.js"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_text_1", content: "import { createServer }..." },
    ],
  }
  flattenToolExchange(body)
  assert.equal(body.messages.length, 3)
  assert.equal(body.messages[1].role, "assistant")
  assert.ok(!("tool_calls" in body.messages[1]))
  // The assistant says only what it said; the call itself is never written in
  // its voice (a wording that named the arguments was copied back verbatim,
  // measured 2026-11-17), so no argument JSON appears there at all.
  assert.equal(body.messages[1].content, "Let me read it.")
  assert.ok(!body.messages[1].content.includes("{"), "no argument text in the assistant's own words")
  assert.equal(body.messages[2].role, "user")
  assert.equal(body.messages[2].content, "The tool returned:\nimport { createServer }...")
})

test("messages without calls or tool roles pass through byte for byte", () => {
  const body = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  }
  flattenToolExchange(body)
  assert.deepEqual(body.messages, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ])
})

test("a tool result is joined with an existing user message", () => {
  const body = {
    messages: [
      { role: "user", content: "run npm test" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: '{"command":"npm test"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "pass 3" },
      { role: "user", content: "now edit it" },
    ],
  }
  flattenToolExchange(body)
  assert.equal(body.messages.length, 4)
  assert.equal(body.messages[2].role, "user")
  assert.equal(body.messages[2].content, "The tool returned:\npass 3")
  assert.equal(body.messages[3].content, "now edit it")
})

test("prepareChatBody flattens the exchange for a kimi model", () => {
  const parsed = {
    model: "codearts/kimi-k3",
    max_tokens: 100,
    stream: true,
    messages: [
      { role: "user", content: "read a file" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "contents" },
    ],
    tools: [{ type: "function", function: { name: "Read", description: "read", parameters: {} } }],
  }
  const chat = prepareChatBody(parsed)
  assert.ok(chat)
  assert.equal(chat.body.messages[1].role, "assistant")
  assert.ok(!("tool_calls" in chat.body.messages[1]))
  assert.equal(chat.body.messages[2].role, "user")
})

test("prepareChatBody leaves a non-kimi model's exchange alone", () => {
  const parsed = {
    model: "codearts/deepseek-v4.1-flash",
    max_tokens: 100,
    stream: true,
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "Bash", description: "run", parameters: {} } }],
  }
  const chat = prepareChatBody(parsed)
  assert.ok(chat)
  assert.ok(Array.isArray(chat.body.messages[1].tool_calls))
  assert.equal(chat.body.messages[2].role, "tool")
})

// ---- a run of parameters with no invoke at all --------------------------------

test("a nameless parameter run is wrapped as the one tool whose schema fits", () => {
  const fix = dsmlNameFix(offeredWith({ Bash: ["command", "description"], Read: ["file_path"] }))
  const text = '<parameter name="command">Get-Date</parameter>\n<parameter name="description">read the clock</parameter>'
  assert.equal(
    bareParamsToDsml(text, fix),
    '<｜DSML｜ invoke name="Bash"><parameter name="command">Get-Date</parameter>\n<parameter name="description">read the clock</parameter></｜DSML｜ invoke>',
  )
})

test("two tools that both fit the parameters are not guessed between", () => {
  const fix = dsmlNameFix(offeredWith({ Bash: ["command"], Exec: ["command"] }))
  const text = '<parameter name="command">Get-Date</parameter>'
  assert.equal(bareParamsToDsml(text, fix), text)
})

test("parameters naming no offered tool are left as text", () => {
  const fix = dsmlNameFix(offeredWith({ Read: ["file_path"] }))
  const text = '<parameter name="nonsense">x</parameter>'
  assert.equal(bareParamsToDsml(text, fix), text)
})

test("a run inside a fenced code block is never executed", () => {
  const fix = dsmlNameFix(offeredWith({ Bash: ["command"] }))
  const inner = '<parameter name="command">rm -rf /tmp/demo</parameter>'
  const text = 'Like this:\n```\n' + inner + '\n```\n'
  assert.equal(bareParamsToDsml(text, fix), text)
})

test("parameters already inside an invoke are its arguments, not a new call", () => {
  const fix = dsmlNameFix(offeredWith({ Bash: ["command"] }))
  const text = '<｜DSML｜ invoke name="Bash"><parameter name="command">Get-Date</parameter></｜DSML｜ invoke>'
  assert.equal(bareParamsToDsml(text, fix), text)
})

test("fixDsmlNames applies the bare-parameter repair before its DSML gate", () => {
  const fix = dsmlNameFix(offeredWith({ Bash: ["command"] }))
  const out = fixDsmlNames('<parameter name="command">Get-Date</parameter>', fix, false)
  assert.ok(out.includes('<｜DSML｜ invoke name="Bash">'))
})

// ---- DeepSeek's bare function-call form ---------------------------------------

test("a <tool_call> written Foo(key: value) becomes the rescued markup", () => {
  const fix = dsmlNameFix(offered(["Read"]))
  const text = '<tool_call>\nRead(file_path: "src/server.js")\n</tool_call>'
  assert.equal(
    fixDsmlNames(text, fix, true),
    '<｜DSML｜ invoke name="Read"><｜DSML｜ parameter name="file_path" string="true">src/server.js</｜DSML｜ parameter></｜DSML｜ invoke>',
  )
})

test("key=value, unquoted numbers and commas inside quotes are read right", () => {
  const fix = dsmlNameFix(offered(["Bash"]))
  const text = '<tool_call>Bash(command="echo a, b", timeout: 30, run_in_background: true)</tool_call>'
  const out = fixDsmlNames(text, fix, true)
  assert.ok(out.includes('name="command" string="true">echo a, b<'), out)
  assert.ok(out.includes('name="timeout">30<'), out)
  assert.ok(out.includes('name="run_in_background">true<'), out)
})

test("a name the request never offered stays text", () => {
  const fix = dsmlNameFix(offered(["Read"]))
  const text = '<tool_call>Teleport(to: "mars")</tool_call>'
  assert.equal(fixDsmlNames(text, fix, true), text)
})

test("an argument this reader cannot parse leaves the whole block alone", () => {
  const fix = dsmlNameFix(offered(["Read"]))
  const text = '<tool_call>Read(just-a-string)</tool_call>'
  assert.equal(fixDsmlNames(text, fix, true), text)
})

test("a no-argument call still becomes an invoke", () => {
  const fix = dsmlNameFix(offered(["get_time"]))
  assert.equal(
    fixDsmlNames("<tool_call>get_time()</tool_call>", fix, true),
    '<｜DSML｜ invoke name="get_time"></｜DSML｜ invoke>',
  )
})

// ---- holding back a call still being written ---------------------------------

test("a finished call is not held back", () => {
  const text = 'Done.\n<parameter name="command">Get-Date</parameter>'
  assert.equal(holdUnfinishedCall(text), text)
})

test("a parameter run with no close is held back to before it", () => {
  assert.equal(
    holdUnfinishedCall('Done.\n<parameter name="command">Get-Da'),
    "Done.\n",
  )
})

test("an unclosed Kimi section is held back", () => {
  assert.equal(holdUnfinishedCall('ok\n<|open|>call tool="Grep"<|sep|>x'), "ok\n")
})

test("plain prose with no markup is untouched", () => {
  assert.equal(holdUnfinishedCall("just words"), "just words")
})

test("snapshots stay append-only once the repair wraps a run", () => {
  const fix = dsmlNameFix(offeredWith({ Bash: ["command"] }))
  // What CodeArts sends: the same answer, growing.
  const s1 = 'Fine.\n<parameter name="command">Get-Da'
  const s2 = 'Fine.\n<parameter name="command">Get-Date</parameter>'
  const held1 = holdUnfinishedCall(s1)
  const held2 = holdUnfinishedCall(s2)
  const fixed1 = fixDsmlNames(held1, fix, true)
  const fixed2 = fixDsmlNames(held2, fix, true)
  assert.equal(fixed1, "Fine.\n")
  assert.ok(fixed2.startsWith(fixed1), "the second snapshot must extend the first, or the reader re-sends the whole answer")
  assert.ok(fixed2.includes('<｜DSML｜ invoke name="Bash">'))
})
