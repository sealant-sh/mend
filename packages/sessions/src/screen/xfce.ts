import { CHROMIUM_WRAPPER_PATH } from "../session-socket.ts";

// DESIGN.md §1: canvas, working sheet, ink and warm hairline, copied for native X clients.
const CANVAS = "#edeae4";
const SHEET = "#faf9f7";
const INK = "#1b1b1d";
const RULE = "#cbc8c1";
const THEME = "Mend";

const property = (name: string, type: string, value: string | number | boolean) =>
  `<property name="${name}" type="${type}" value="${value}"/>`;
const group = (name: string, children: string) =>
  `<property name="${name}" type="empty">${children}</property>`;
const array = (name: string, type: string, values: ReadonlyArray<string | number>) =>
  `<property name="${name}" type="array">${values.map((value) => `<value type="${type}" value="${value}"/>`).join("")}</property>`;
const channel = (name: string, properties: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<channel name="${name}" version="1.0">${properties}</channel>\n`;
const write = (path: string, content: string) =>
  `cat >"${path}" <<'MEND_XFCE'\n${content}\nMEND_XFCE\n`;
const config = (name: string, properties: string) =>
  write(`$conf/${name}.xml`, channel(name, properties));

const session = config(
  "xfce4-session",
  group(
    "general",
    property("FailsafeSessionName", "string", "Mend") +
      property("SessionName", "string", "Mend") +
      property("SaveOnExit", "bool", false) +
      property("LockCommand", "string", ""),
  ) +
    group("chooser", property("AlwaysDisplay", "bool", false)) +
    group(
      "startup",
      group("ssh-agent", property("enabled", "bool", false)) +
        group("gpg-agent", property("enabled", "bool", false)),
    ) +
    group(
      "sessions",
      group(
        "Mend",
        property("IsFailsafe", "bool", true) +
          property("Count", "int", 5) +
          ["xfwm4", "xfsettingsd", "xfce4-panel", "Thunar", "xfdesktop"]
            .map(
              (command, index) =>
                array(
                  `Client${index}_Command`,
                  "string",
                  command === "Thunar" ? [command, "--daemon"] : [command],
                ) +
                property(`Client${index}_Priority`, "int", 15 + index * 5) +
                property(`Client${index}_PerScreen`, "bool", false),
            )
            .join(""),
      ),
    ),
);
const panel = (
  id: number,
  size: number,
  position: string,
  length: number,
  plugins: ReadonlyArray<number>,
) =>
  group(
    `panel-${id}`,
    property("position", "string", position) +
      property("position-locked", "bool", true) +
      property("size", "uint", size) +
      property("length", "uint", length) +
      property("length-adjust", "bool", true) +
      property("autohide-behavior", "uint", 0) +
      array("plugin-ids", "int", plugins),
  );
const panels = config(
  "xfce4-panel",
  property("configver", "int", 2) +
    `<property name="panels" type="array"><value type="int" value="1"/><value type="int" value="2"/>` +
    panel(1, 26, "p=6;x=640;y=0", 100, [1]) +
    panel(2, 48, "p=10;x=640;y=800", 1, [2, 3, 4]) +
    "</property>" +
    group(
      "plugins",
      `<property name="plugin-1" type="string" value="clock">` +
        property("mode", "uint", 2) +
        property("digital-format", "string", "%a %d %b  %H:%M") +
        "</property>" +
        [2, 3, 4]
          .map(
            (id) =>
              `<property name="plugin-${id}" type="string" value="launcher">${array("items", "string", ["mend.desktop"])}</property>`,
          )
          .join(""),
    ),
);
const backdrop =
  property("image-style", "int", 0) +
  property("color-style", "int", 2) +
  array("rgba1", "double", [250 / 255, 249 / 255, 247 / 255, 1]) +
  array("rgba2", "double", [237 / 255, 234 / 255, 228 / 255, 1]);
const desktop = config(
  "xfce4-desktop",
  group("desktop-icons", property("style", "int", 0)) +
    group("backdrop", group("screen0", group("monitorVNC-0", group("workspace0", backdrop)))),
);
const settings = config(
  "xsettings",
  group(
    "Net",
    property("ThemeName", "string", "Adwaita") + property("IconThemeName", "string", "Adwaita"),
  ) + group("Gtk", property("FontName", "string", "DejaVu Sans 10")),
);
const keyboard = config("keyboard-layout", group("Default", property("XkbDisable", "bool", true)));
const wm = config(
  "xfwm4",
  group(
    "general",
    property("theme", "string", THEME) +
      property("button_layout", "string", "CHM|") +
      property("title_font", "string", "DejaVu Sans 10") +
      property("workspace_count", "int", 1) +
      property("use_compositing", "bool", false),
  ),
);

const xpm = (width: number, height: number, color: string, rows?: ReadonlyArray<string>) =>
  `/* XPM */\nstatic char *mend[] = {\n"${width} ${height} 2 1",\n"  c None",\n". c ${color}",\n${(rows ?? Array.from({ length: height }, () => ".".repeat(width))).map((row) => `"${row}"`).join(",\n")}\n};`;
const circle = Array.from({ length: 28 }, (_, y) =>
  Array.from({ length: 20 }, (_column, x) =>
    (x - 9.5) ** 2 + (y - 13.5) ** 2 <= 30 ? "." : " ",
  ).join(""),
);
const theme =
  write(
    "$theme/themerc",
    `active_text_color=${INK}
inactive_text_color=#6e6e76
active_color_1=${SHEET}
inactive_color_1=${CANVAS}
button_spacing=0
button_offset=4
full_width_title=true
show_app_icon=false
title_alignment=center
title_shadow_active=false
title_shadow_inactive=false
frame_border_top=0
maximized_offset=4
`,
  ) +
  ["active", "inactive"]
    .map((state) => {
      const fill = state === "active" ? SHEET : CANVAS;
      return (
        ["title-1", "title-2", "title-3", "title-4", "title-5", "top-left", "top-right"]
          .map((part) => write(`$theme/${part}-${state}.xpm`, xpm(2, 28, fill)))
          .join("") +
        ["left", "right", "bottom", "bottom-left", "bottom-right"]
          .map((part) => write(`$theme/${part}-${state}.xpm`, xpm(1, 1, RULE)))
          .join("") +
        [
          ["close", "#ff5f57"],
          ["hide", "#febc2e"],
          ["maximize", "#28c840"],
        ]
          .map(([button, color]) =>
            [state, `${state}-prelight`, `${state}-pressed`]
              .map((variant) =>
                write(`$theme/${button}-${variant}.xpm`, xpm(20, 28, color ?? RULE, circle)),
              )
              .join(""),
          )
          .join("")
      );
    })
    .join("");
const launchers = [
  ["Chromium", CHROMIUM_WRAPPER_PATH, "chromium"],
  ["Files", "Thunar", "system-file-manager"],
  ["Terminal", "xfce4-terminal", "utilities-terminal"],
]
  .map(([name, command, icon], index) =>
    write(
      `$XDG_CONFIG_HOME/xfce4/panel/launcher-${index + 2}/mend.desktop`,
      `[Desktop Entry]\nType=Application\nName=${name}\nExec=${command}\nIcon=${icon}\nTerminal=false\nStartupNotify=false\n`,
    ),
  )
  .join("");

/** Seeds the screen's private XFCE session and Mend's native window theme on every start. */
export const XFCE_CONFIG_SCRIPT = `export XDG_CONFIG_HOME="$dir/config" XDG_CACHE_HOME="$dir/cache" XDG_DATA_HOME="$dir/data" XDG_STATE_HOME="$dir/state" XDG_RUNTIME_DIR="$dir/runtime"
export GTK_THEME=Adwaita
conf=$XDG_CONFIG_HOME/xfce4/xfconf/xfce-perchannel-xml
theme=$XDG_DATA_HOME/themes/${THEME}/xfwm4
mkdir -p "$conf" "$theme" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME/gtk-3.0" "$dir/chromium/Default"
for id in 2 3 4; do mkdir -p "$XDG_CONFIG_HOME/xfce4/panel/launcher-$id"; done
${session}${panels}${desktop}${settings}${keyboard}${wm}${theme}${launchers}
${write("$XDG_CONFIG_HOME/xfce4/xinitrc", '#!/bin/sh\n# Keep image-wide autostarts and keyboard setup out of this screen.\nexport XDG_CONFIG_DIRS="$XDG_CONFIG_HOME"\nexec xfce4-session')}
${write("$XDG_CONFIG_HOME/gtk-3.0/gtk.css", `.xfce4-panel { background: ${SHEET}; color: ${INK}; border-color: ${RULE}; }`)}
${write("$dir/chromium/Default/Preferences", '{"browser":{"custom_chrome_frame":false}}')}
`;
