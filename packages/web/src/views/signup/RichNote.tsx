// A text with inline links (views/signup/copy.ts `RichText`): the ways out of a refused sign-up ("sign
// in", "reset your password", "let's talk"). Links of the app move inside it without a reload (the
// sign-up's memory survives); Craftech's contact page opens in a new tab.
import { Link } from "../../lib/router";
import type { RichText } from "./copy";

const LINK = "font-semibold underline underline-offset-2";

export function RichNote({ text }: { readonly text: RichText }) {
  return (
    <>
      {text.map((part, index) => {
        if (typeof part === "string") return <span key={index}>{part}</span>;
        if (part.external) {
          return (
            <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className={LINK}>
              {part.label}
            </a>
          );
        }
        return (
          <Link key={index} to={part.href} className={LINK}>
            {part.label}
          </Link>
        );
      })}
    </>
  );
}
