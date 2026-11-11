// Empty top strip for layouts without a tab bar: matches the tab bar's look and lets the block
// (window_drag in the layout) move the window. Optional props: { "title": "Overview" }.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, theme } from "herdr";
import { TS } from "./ui.js";

export default class TitleStrip extends View {
  render() {
    const t = theme();
    const title = props()?.title;
    return h_flex().id("title-strip").size_full().px(14).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .when(Boolean(title), (el) => el.child(div().text_size(TS.body).font_medium().text_color(t.muted).child(title)));
  }
}
