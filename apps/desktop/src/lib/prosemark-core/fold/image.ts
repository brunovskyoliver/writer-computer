import { Decoration, type EditorView, WidgetType } from "@codemirror/view";
import { normalizeMarkdownDestination } from "@/lib/paths";
import { foldableSyntaxFacet, selectAllDecorationsOnSelectExtension } from "./core";
import { iterChildren } from "../utils";
import { resolveImageSrc } from "../imageSrc";

// Last measured widget height per markdown destination. Images decode async,
// so without a remembered height every scroll past an unloaded image inserts
// a ~1-line placeholder that later snaps to natural size and shifts the
// heightmap under the viewport (the "jumpy scroll"). The cache survives
// widget rebuilds and re-opens of the same document.
const imageHeightCache = new Map<string, number>();
const IMAGE_HEIGHT_LIMIT = 256;

/** Fingerprints are advisory layout hints. Keep encoded image bytes out of
 * persistent keys; a collision is corrected when the image decodes. */
function imageHeightKey(source: string): string {
  if (source.length <= 512 && !/^data:/i.test(source)) return source;
  let first = 2166136261;
  let second = 2246822519;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489917);
  }
  return `\0image:${source.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

function measuredHeight(key: string): number | undefined {
  const height = imageHeightCache.get(key);
  if (height !== undefined) {
    imageHeightCache.delete(key);
    imageHeightCache.set(key, height);
  }
  return height;
}

function rememberHeight(key: string, height: number) {
  imageHeightCache.delete(key);
  imageHeightCache.set(key, height);
  if (imageHeightCache.size > IMAGE_HEIGHT_LIMIT) {
    const oldest = imageHeightCache.keys().next().value;
    if (oldest !== undefined) imageHeightCache.delete(oldest);
  }
}

/** Shared height-stability wiring for async-loading editor images (markdown
 *  images and wiki embeds): reserve the last measured height for `cacheKey`
 *  until this element (re)decodes, record the settled height, and ask the
 *  view to re-measure so its scroll anchoring compensates. `load` can fire
 *  more than once when a resolver rewrites `src` after insertion; the last
 *  one wins. */
export function attachStableImageHeight(
  image: HTMLImageElement,
  container: HTMLElement,
  cacheKey: string,
  view: EditorView,
): void {
  const key = imageHeightKey(cacheKey);
  const cached = measuredHeight(key);
  if (cached !== undefined) {
    image.style.height = `${cached}px`;
  }
  image.addEventListener("load", () => {
    image.style.height = "";
    const height = container.getBoundingClientRect().height;
    if (height > 0) {
      rememberHeight(key, height);
    }
    view.requestMeasure();
  });
  image.addEventListener("error", () => {
    image.style.height = "";
    view.requestMeasure();
  });
}

class ImageWidget extends WidgetType {
  private readonly heightKey: string;
  constructor(
    public url: string,
    public block?: boolean,
  ) {
    super();
    this.heightKey = imageHeightKey(url);
  }

  eq(other: ImageWidget): boolean {
    return this.url === other.url && this.block === other.block;
  }

  get estimatedHeight(): number {
    return measuredHeight(this.heightKey) ?? -1;
  }

  toDOM(view: EditorView) {
    const elem = document.createElement(this.block ? "div" : "span");
    elem.className = "cm-image";
    if (this.block) {
      elem.className += " cm-image-block";
    }
    const image = document.createElement("img");
    attachStableImageHeight(image, elem, this.heightKey, view);
    image.src = resolveImageSrc(view.state, this.url);
    elem.appendChild(image);
    return elem;
  }

  // allows clicks to pass through to the editor
  ignoreEvent(_event: Event) {
    return false;
  }
}

export const imageExtension = [
  foldableSyntaxFacet.of({
    nodePath: "Image",
    keepDecorationOnUnfold: true,
    buildDecorations: (state, node, selectionTouchesRange) => {
      let imageUrl: string | undefined;
      iterChildren(node.node.cursor(), (node) => {
        if (node.name === "URL") {
          imageUrl = normalizeMarkdownDestination(state.doc.sliceString(node.from, node.to));
        }

        return undefined;
      });

      if (imageUrl) {
        const line = state.doc.lineAt(node.from);
        const block = node.from == line.from && node.to == line.to;
        const widget = new ImageWidget(imageUrl, block);

        if (selectionTouchesRange) {
          return Decoration.widget({
            widget,
            block,
          }).range(node.to, node.to);
        } else {
          return Decoration.replace({
            widget,
            block,
          }).range(node.from, node.to);
        }
      }
    },
  }),
  selectAllDecorationsOnSelectExtension("cm-image"),
];

export const __testImage = {
  imageHeightCache,
};
