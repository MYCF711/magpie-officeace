import test from "node:test"
import assert from "node:assert/strict"
import { _internal } from "../src/codearts/index.mjs"

const { dsmlNameFix, fixDsmlNames, antmlToDsml, toolCallFnToDsml, xmlCallToDsml } = _internal

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
