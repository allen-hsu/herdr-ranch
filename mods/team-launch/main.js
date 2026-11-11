// Start an agent team in one line: ⌃⌘N (mod.open team-launch), the Team map's "New team…", or a repo row's
// team button in the sidebar. Type the task, Enter. The repo is where you are (props.repo, else the focused
// terminal's folder); the pattern defaults to Maker / Checker; roles come from agent-team.json.
// props.full (+ prefill) shows every field — "More options…". All the logic is lib/newteam.js.
import { View, div } from "gpui-kit";
import { props, theme } from "herdr";
import { NewTeam } from "./newteam.js";

export default class TeamLaunch extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.form = new NewTeam({ ...p, compact: !p.full }, cx);
  }
  render() { return this.form ? this.form.render(theme()) : div(); }
}
