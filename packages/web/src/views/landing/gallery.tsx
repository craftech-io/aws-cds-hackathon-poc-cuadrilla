// One gallery for every picture of the landing, in manifest order: any figure opens it at its own
// picture, and the viewer walks to the previous and next ones. React context, no state library.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Lightbox } from "./Lightbox";
import type { MediaItem, MediaState } from "./media";

export interface GalleryItem extends MediaItem {
  readonly id: string;
}

interface Gallery {
  readonly open: (id: string) => void;
}

const GalleryContext = createContext<Gallery | undefined>(undefined);

export function galleryItems(media: MediaState): GalleryItem[] {
  return media.status === "ready"
    ? Object.entries(media.manifest.media).map(([id, item]) => ({
        id,
        ...item,
      }))
    : [];
}

export function GalleryProvider({
  media,
  children,
}: {
  readonly media: MediaState;
  readonly children: ReactNode;
}) {
  const items = useMemo(() => galleryItems(media), [media]);
  const [index, setIndex] = useState<number | undefined>(undefined);
  const open = useCallback(
    (id: string) => {
      const found = items.findIndex((item) => item.id === id);
      if (found >= 0) setIndex(found);
    },
    [items],
  );
  const gallery = useMemo(() => ({ open }), [open]);
  return (
    <GalleryContext.Provider value={gallery}>
      {children}
      <Lightbox
        items={items}
        index={index}
        onIndex={setIndex}
        onClose={() => setIndex(undefined)}
      />
    </GalleryContext.Provider>
  );
}

/** `undefined` outside a GalleryProvider: the figure then renders without zoom. */
export function useGallery(): Gallery | undefined {
  return useContext(GalleryContext);
}
