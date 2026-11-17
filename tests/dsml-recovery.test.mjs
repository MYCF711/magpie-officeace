import test from "node:test"
import assert from "node:assert/strict"
import { _internal } from "../src/codearts/index.mjs"

const { dsmlNameFix, fixDsmlNames, antmlToDsml, toolCallFnToDsml } = _internal

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
