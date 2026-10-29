import { isDrawingPath } from "@/lib/drawings";
import type {
  DrawingLocation,
  Location,
  SerializedLocation,
} from "@/components/editor-area/page-kinds";

/** Upgrade old Markdown drawing tabs without resetting state owned by other kinds. */
export function normalizeDrawingLocation<T extends Location | SerializedLocation>(
  location: T,
): T | DrawingLocation {
  return location.kind === "file" &&
    "path" in location &&
    typeof location.path === "string" &&
    isDrawingPath(location.path)
    ? { kind: "drawing", path: location.path }
    : location;
}
