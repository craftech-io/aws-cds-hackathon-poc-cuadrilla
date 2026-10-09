// An audio, photo or document of a work order behind a GET link of 5 minutes (`orders.mediaUrl`, FL-080):
// the link is asked when the person opens it (or right away with `auto`), never kept, and the player or
// the image uses it at once. Keys of S3 never reach the console; only the link does.
import { useState } from "react";
import { Button } from "../../components/Button";
import { useRemote } from "../../lib/use-remote";
import { useConsoleApi } from "../orders/use-field-data";
import { detailCopy } from "./copy";
import { DETAIL_PROCEDURES, MediaLink, type MediaRef } from "./order-detail-model";

export type MediaKind = "AUDIO" | "IMAGE" | "DOCUMENT";

interface RemoteMediaProps {
  readonly workOrderId: string;
  readonly media: MediaRef;
  readonly kind: MediaKind;
  /** The button that opens it ("Escuchar la nota de voz", "Ver la foto"). */
  readonly openLabel: string;
  /** Alternative text of a photo; the accessible name of a player. */
  readonly description: string;
  /** Asks the link on mount (the evidence review shows every photo). */
  readonly auto?: boolean;
}

function Player({ kind, url, description }: { readonly kind: MediaKind; readonly url: string; readonly description: string }) {
  if (kind === "AUDIO") return <audio controls preload="metadata" src={url} aria-label={description} className="w-full max-w-sm" />;
  if (kind === "IMAGE") return <img src={url} alt={description} className="max-h-72 w-auto max-w-full rounded-md border border-mist object-contain" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-cyan-deep underline">
      {detailCopy.timeline.openDocument}
    </a>
  );
}

export function RemoteMedia({ workOrderId, media, kind, openLabel, description, auto = false }: RemoteMediaProps) {
  const api = useConsoleApi();
  const [asked, setAsked] = useState(auto ? 1 : 0);
  const key = asked === 0 ? null : `media:${workOrderId}:${JSON.stringify(media)}:${asked}`;
  const remote = useRemote(key, (signal) => api.query(DETAIL_PROCEDURES.mediaUrl, { workOrderId, ...media }, MediaLink, signal));
  const ask = () => setAsked((value) => value + 1);

  switch (remote.state.status) {
    case "idle":
      // Its own box, so a column of the timeline never stretches the button across.
      return (
        <span className="flex">
          <Button variant="secondary" onClick={ask}>
            {openLabel}
          </Button>
        </span>
      );
    case "loading":
      return <span className="text-xs text-slate">{detailCopy.timeline.loadingMedia}</span>;
    case "error":
      return (
        <span className="flex flex-wrap items-center gap-2 text-xs text-danger">
          {detailCopy.timeline.mediaFailed}
          <Button variant="ghost" onClick={ask}>
            {openLabel}
          </Button>
        </span>
      );
    case "ready":
      return <Player kind={kind} url={remote.state.data.url} description={description} />;
  }
}
