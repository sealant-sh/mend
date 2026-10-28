// oxlint-disable-next-line import/no-unassigned-import -- a CSS import is a side effect in Vite.
import "./style.css";
import { message } from "./message.js";

const render = (text) => {
  document.querySelector("#message").textContent = text;
};

render(message);

if (import.meta.hot) {
  import.meta.hot.accept("./message.js", (next) => {
    if (next) render(next.message);
  });
}
