import { Fragment } from "react";

/**
 * A code of hyphenated groups that may wrap after any hyphen. Line breaking (UAX #14) keeps a
 * hyphen with a digit that follows it, as in "-5", so a pairing code whose groups start with
 * digits stayed one long word and pushed Add a device past a tablet's width (#1911).
 */
export function Grouped({ code }: { code: string }) {
  return code.split("-").map((group, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the groups never move.
    <Fragment key={i}>
      {i > 0 && (
        <>
          -<wbr />
        </>
      )}
      {group}
    </Fragment>
  ));
}
