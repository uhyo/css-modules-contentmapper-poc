import styles from "./button.module.css";

export function render(): string {
  const cls: string = styles.button;
  const title: string = styles["card-title"];
  const wide: string = styles["wide-only"];
  return `<button class="${cls}"><span class="${title} ${wide}">ok</span></button>`;
}
