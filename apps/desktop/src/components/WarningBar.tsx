import { Icon } from "./Icon";

/** Paper bar under the strip. The first sentence of the warning is bold. */
export function WarningBar({ text }: { text: string }) {
  const cut = text.indexOf(". ");
  const lead = cut === -1 ? text : text.slice(0, cut + 1);
  const rest = cut === -1 ? "" : text.slice(cut + 1);
  return (
    <div className="warn" role="status">
      <Icon name="alert" size={13} />
      <b>{lead}</b>
      {rest}
    </div>
  );
}
