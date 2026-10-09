// One gallery for the console views of the landing, in manifest order: any thumbnail opens the viewer
// at its own view, and the viewer walks to the previous and next ones; closing it gives the focus back
// to the thumbnail that opened it. React context, no state library.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Lightbox } from "./Lightbox";
import type { MediaItem, MediaState } from "./media";
import { GALLERY_IDS } from "./story";

export interface GalleryItem {
  readonly id: string;
  readonly item: MediaItem;
}

interface Gallery {
  readonly items: readonly GalleryItem[];
  readonly open: (id: string, opener?: HTMLElement | null) => void;
}

const GalleryContext = createContext<Gallery | undefined>(undefined);

/** The gallery's entries the manifest describes, in manifest order. */
export function galleryItems(media: MediaState): GalleryItem[] {
  if (media.status !== "ready") return [];
  const wanted = new Set<string>(GALLERY_IDS);
  return Object.entries(media.manifest.media)
    .filter(([id]) => wanted.has(id))
    .map(([id, item]) => ({ id, item }));
}

export function GalleryProvider({ media, children }: { readonly media: MediaState; readonly children: ReactNode }) {
  const items = useMemo(() => galleryItems(media), [media]);
  const [index, setIndex] = useState<number | undefined>(undefined);
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback(
    (id: string, from?: HTMLElement | null) => {
      const found = items.findIndex((item) => item.id === id);
      if (found < 0) return;
      opener.current = from ?? null;
      setIndex(found);
    },
    [items],
  );
  const close = useCallback(() => {
    setIndex(undefined);
    const back = opener.current;
    opener.current = null;
    if (back) window.requestAnimationFrame(() => back.focus());
  }, []);
  const gallery = useMemo(() => ({ items, open }), [items, open]);
  return (
    <GalleryContext.Provider value={gallery}>
      {children}
      <Lightbox items={items} index={index} onIndex={setIndex} onClose={close} />
    </GalleryContext.Provider>
  );
}

/** `undefined` outside a GalleryProvider: a figure then renders without zoom. */
export function useGallery(): Gallery | undefined {
  return useContext(GalleryContext);
}
