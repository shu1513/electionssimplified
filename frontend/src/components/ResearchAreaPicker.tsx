import { useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { INTEGRITY_ETHICS_SLUG, sortByResearchAreaPriority } from "@voteapp/api-client";
import { newRankedResearchArea, type RankedResearchArea } from "../lib/rankedResearchAreas";

// Controlled ranked-selection editor for research areas, shared by the
// post-signup welcome step and the settings section. The parent owns the
// ordered list and persistence; every edit (add, remove, reorder, direction,
// must) comes back as one complete next list through onChange,
// so the parent can save per-edit (settings) or batch into a single save
// (welcome). List position is the rank: first = rank 1. No cap on length.
//
// Two panels, side by side from lg up: the ranked list (a drop zone) and the
// pool of issues. Tapping a pool card appends it — that path, not drag, is
// the accessible one — and dragging an unchosen card onto the ranked panel
// inserts it where it drops. Chosen issues stay in the pool (tinted, with a
// rank badge; tapping again unselects), so the grid never reflows under the
// user mid-selection — and the ranked list growing beside it, not above it,
// no longer pushes the choices down (the complaint with the old stacked
// layout).

export type ResearchAreaOption = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
};

// layout: "split" shows both panels (settings); "pool" and "ranked" show one
// panel each, for the welcome flow's two steps — new users kept missing the
// ranking half when both panels shared a screen, so it gets its own step.
// In "pool" the cards mark selection with a check, not a rank number:
// ordering is not a concept yet on that step.
export type ResearchAreaPickerLayout = "split" | "pool" | "ranked";

type ResearchAreaPickerProps = {
  /** Every area the ranked rows may name (the catalog, or at least the
   * ranked areas plus the pool). */
  areas: ResearchAreaOption[];
  ranked: RankedResearchArea[];
  disabled: boolean;
  onChange: (next: RankedResearchArea[]) => void;
  layout?: ResearchAreaPickerLayout;
  /** Restricts the pool to these areas (the auto-pick "add these issues"
   * dialog offers only the race's relevant issues) while the ranked panel
   * still shows the user's whole list. Omitted: the pool is `areas`. */
  poolAreas?: ResearchAreaOption[];
  /** Stacked order (below lg, where the panels do not sit side by side):
   * the pool first, then the ranked list. The auto-pick dialog's job is to
   * choose from the race's few issues, and a long priority list above them
   * would push that choice below the fold. Settings keeps ranked first. */
  poolFirst?: boolean;
  /** Replaces the pool heading ("Choose issues (N selected · no limit)")
   * — the auto-pick dialog names the race instead, with no count. */
  poolTitle?: string;
  /** A ranked row to tint (the auto-pick dialog flashes the row an issue
   * just landed in, since the list can sit below the fold there). */
  highlightedId?: string | null;
};

const RANKED_PANEL_ID = "ranked-panel";
const POOL_ID_PREFIX = "pool-";

export function ResearchAreaPicker({
  areas,
  ranked,
  disabled,
  onChange,
  layout = "split",
  poolAreas,
  poolFirst = false,
  poolTitle,
  highlightedId = null,
}: ResearchAreaPickerProps) {
  // Mouse: drag starts after 4px of movement, so the buttons stay plain
  // clicks. Touch: press-and-hold (200ms) then drag, so the lists do not
  // hijack page scrolling. Keyboard sorting stays for accessibility.
  // MouseSensor + TouchSensor deliberately, not PointerSensor: PointerSensor
  // also claims touch input, which would bypass the press-and-hold delay.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const areaById = new Map(areas.map((area) => [area.id, area]));
  const orderedIds = ranked.map((row) => row.research_area_id);

  // Pool draggables carry a "pool-" prefix: a chosen issue exists in BOTH
  // panels (sortable row + tinted pool card), and dnd-kit ids must be unique
  // per context.
  //
  // Reorders resolve against row/panel centers so keyboard sorting (which has
  // no pointer) keeps working — minus the panel itself, whose large center
  // could otherwise beat the intended row and turn a reorder into a no-op.
  // Pool drags demand the pointer actually inside a target: closest-center
  // would return SOME target even for a card dropped back in the pool, which
  // would add it.
  const collisionDetection: CollisionDetection = (args) => {
    if (String(args.active.id).startsWith(POOL_ID_PREFIX)) {
      return pointerWithin(args);
    }
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((c) => c.id !== RANKED_PANEL_ID),
    });
  };

  function addAt(id: string, index: number) {
    const next = [...ranked];
    next.splice(index, 0, newRankedResearchArea(id));
    onChange(next);
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) {
      return;
    }
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId.startsWith(POOL_ID_PREFIX)) {
      // Pool card: dropped on a ranked row takes that row's rank; dropped on
      // the panel's empty space appends.
      const areaId = activeId.slice(POOL_ID_PREFIX.length);
      const to = orderedIds.indexOf(overId);
      if (to >= 0) {
        addAt(areaId, to);
      } else if (overId === RANKED_PANEL_ID) {
        addAt(areaId, ranked.length);
      }
      return;
    }
    const from = orderedIds.indexOf(activeId);
    const to = orderedIds.indexOf(overId);
    if (from < 0 || to < 0 || from === to) {
      return;
    }
    onChange(arrayMove(ranked, from, to));
  }

  function remove(id: string) {
    onChange(ranked.filter((row) => row.research_area_id !== id));
  }

  function update(id: string, patch: Partial<Omit<RankedResearchArea, "research_area_id">>) {
    onChange(ranked.map((row) => (row.research_area_id === id ? { ...row, ...patch } : row)));
  }

  const showRanked = layout !== "pool";
  const showPool = layout !== "ranked";

  // In the split layout the second panel needs air above it while the two
  // are stacked (below lg); side by side they align at the top.
  const secondPanelClass = layout === "split" ? "mt-6 lg:mt-0" : "";
  const rankedPanel = showRanked ? (
    <div key="ranked" className={poolFirst && showPool ? secondPanelClass : ""}>
      <p className="text-sm font-medium text-ink">
        My priorities{" "}
        <span className="font-normal text-ink-soft">(drag to arrange)</span>
      </p>
      <RankedDropZone empty={ranked.length === 0}>
        {ranked.length > 0 ? (
          <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
            <ol className="space-y-1.5">
              {ranked.map((row, index) => {
                const area = areaById.get(row.research_area_id);
                return (
                  <SortableAreaRow
                    key={row.research_area_id}
                    row={row}
                    index={index}
                    name={area?.name ?? "Unknown area"}
                    isEthics={area?.slug === INTEGRITY_ETHICS_SLUG}
                    disabled={disabled}
                    highlighted={row.research_area_id === highlightedId}
                    onChange={(patch) => update(row.research_area_id, patch)}
                    onRemove={() => remove(row.research_area_id)}
                  />
                );
              })}
            </ol>
          </SortableContext>
        ) : (
          <p className="px-4 py-8 text-center text-sm text-ink-soft">
            {layout === "ranked" ? "Nothing to rank yet. Go back and choose an issue." : "Tap an issue to add it here."}
          </p>
        )}
      </RankedDropZone>
    </div>
  ) : null;
  const poolPanel = showPool ? (
    <div key="pool" className={poolFirst || !showRanked ? "" : secondPanelClass}>
      {poolTitle ? (
        <p className="text-sm font-medium text-ink">{poolTitle}</p>
      ) : (
        <p className="text-sm font-medium text-ink">
          Choose issues{" "}
          <span className="font-normal text-ink-soft">
            ({ranked.length > 0 ? `${ranked.length} selected \u00b7 no limit` : "no limit"})
          </span>
        </p>
      )}
      {/* Public-salience order, not the catalog's alphabetical order — the
          same ranking the election and candidate pages use, so the issues
          most users pick first sit at the top of the grid. */}
      <ul className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
        {sortByResearchAreaPriority(poolAreas ?? areas).map((area) => {
          const rank = orderedIds.indexOf(area.id);
          return (
            <PoolAreaCard
              key={area.id}
              area={area}
              rank={rank}
              disabled={disabled}
              draggable={layout === "split"}
              onToggle={() => (rank >= 0 ? remove(area.id) : addAt(area.id, ranked.length))}
            />
          );
        })}
      </ul>
    </div>
  ) : null;

  return (
    <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragEnd={onDragEnd}>
      <div className={`mt-3 ${layout === "split" ? "gap-x-6 lg:grid lg:grid-cols-2 lg:items-start" : ""}`}>
        {poolFirst ? poolPanel : rankedPanel}
        {poolFirst ? rankedPanel : poolPanel}
      </div>
    </DndContext>
  );
}

// The whole left panel accepts pool-card drops, so a drop does not have to
// land exactly on a row — and the empty state has a target at all.
function RankedDropZone({ empty, children }: { empty: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: RANKED_PANEL_ID });
  return (
    <div
      ref={setNodeRef}
      // lg:pb-10: from lg up the panels sit side by side, so the zone keeps
      // an (invisible) catch area under the rows — dropping a card into the
      // empty left-column space right below the list appends instead of
      // dying. Stacked (below lg) the pool sits directly underneath, where
      // that padding would just be a gap.
      className={`mt-2 rounded-lg ${
        empty
          ? `border border-dashed ${isOver ? "border-green-700 bg-green-50" : "border-line"}`
          : `lg:pb-10 ${isOver ? "bg-green-50 ring-2 ring-green-700/40" : ""}`
      }`}
    >
      {children}
    </div>
  );
}

// Compact pool card: name only, with the description behind an ⓘ toggle —
// a tap target, not a title tooltip, because touch never sees tooltips.
// Tap the name to add; press-and-hold (touch) or drag (mouse) to drop it
// into the ranked panel. Drag listeners sit on the <li>, minus the keyboard
// one: with no activator node gating it, dnd-kit would treat Enter/Space
// on the buttons inside (bubbled to the li) as "start dragging" and swallow
// the press. Pool cards have no keyboard drag — Enter/Space adds, and
// ranking afterwards is keyboard-accessible on the rows.
// Chosen cards stay put — tinted green with a rank badge, tap to unselect —
// so the grid never reflows mid-selection; only unchosen cards drag (the
// chosen issue already has a draggable row in the ranked panel).
// draggable=false (pool-only layout): there is no ranked panel to drop on,
// so the card is a plain toggle — no drag listeners, no grab cursor — and the
// badge is a check, not a rank number.
function PoolAreaCard({
  area,
  rank,
  disabled,
  draggable,
  onToggle,
}: {
  area: ResearchAreaOption;
  rank: number;
  disabled: boolean;
  draggable: boolean;
  onToggle: () => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const selected = rank >= 0;
  const { setNodeRef, listeners, transform, isDragging } = useDraggable({
    id: `${POOL_ID_PREFIX}${area.id}`,
    disabled: disabled || selected || !draggable,
  });
  const { onKeyDown: _keyboardDrag, ...dragListeners } = listeners ?? {};
  return (
    <li
      ref={setNodeRef}
      {...(selected || !draggable ? {} : dragListeners)}
      style={{ transform: CSS.Translate.toString(transform) }}
      // flex-col justify-center: grid rows stretch every card to the tallest
      // one in the row, so a short name next to a wrapped two-line neighbor
      // would otherwise sit at the top with a blank strip under it; centering
      // splits that slack evenly.
      // Resting shadow + hover lift + press-down: flat white boxes read as
      // labels, not controls. The inline dnd transform (only set while
      // dragging) overrides the hover translate, so the lift never fights a
      // drag.
      className={`flex flex-col justify-center touch-manipulation select-none rounded-lg border transition hover:border-green-700 active:translate-y-0 active:shadow-sm ${
        selected
          ? "border-green-700 bg-green-50 shadow-none hover:shadow-sm"
          : `${draggable ? "cursor-grab" : ""} bg-surface shadow-sm hover:-translate-y-0.5 hover:shadow-md`
      } ${isDragging ? "z-10 border-green-700 shadow-md" : selected ? "" : "border-line"}`}
    >
      <span className="flex items-stretch">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={selected}
          aria-label={
            selected
              ? draggable
                ? `${area.name}, rank ${rank + 1}. Click to remove.`
                : `${area.name}, selected. Click to remove.`
              : undefined
          }
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm font-medium text-navy disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="min-w-0 flex-1">{area.name}</span>
          {selected ? (
            <span
              aria-hidden
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-700 text-[11px] font-semibold text-white"
            >
              {draggable ? rank + 1 : "✓"}
            </span>
          ) : null}
        </button>
        {area.description ? (
          <button
            type="button"
            aria-expanded={showInfo}
            aria-label={`About ${area.name}`}
            onClick={() => setShowInfo((open) => !open)}
            className="px-2 text-ink-soft hover:text-ink"
          >
            <span
              aria-hidden
              className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px] font-serif italic"
            >
              i
            </span>
          </button>
        ) : null}
      </span>
      {showInfo && area.description ? (
        <p className="px-3 pb-2 text-xs text-ink-soft">{area.description}</p>
      ) : null}
    </li>
  );
}

function SortableAreaRow({
  row,
  index,
  name,
  isEthics,
  disabled,
  highlighted = false,
  onChange,
  onRemove,
}: {
  row: RankedResearchArea;
  index: number;
  name: string;
  isEthics: boolean;
  disabled: boolean;
  highlighted?: boolean;
  onChange: (patch: Partial<Omit<RankedResearchArea, "research_area_id">>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.research_area_id, disabled });
  // The whole row is the drag surface for mouse (grab it anywhere) and touch
  // (press and hold); the buttons inside still click normally thanks to the
  // sensors' activation constraints. Keyboard sorting is anchored on the ⠿
  // handle (setActivatorNodeRef + attributes): without an activator node,
  // dnd-kit treats Space/Enter on ANY element in the row as "start dragging"
  // and swallows the click, so the toggles and × would be unreachable by
  // keyboard.
  // Direction-neutral on purpose: with Oppose selected, the veto fires on
  // records that SUPPORT the goal, so "who opposes this" would read backwards.
  const vetoLabel = isEthics
    ? "Skip candidates with a negative ethics record (a violation, sanction, or conviction)"
    : "Must: never pick a candidate or measure that goes against my position on this";
  return (
    <li
      ref={setNodeRef}
      {...listeners}
      data-research-area-id={row.research_area_id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // touch-manipulation, not touch-none: the TouchSensor prevents
      // scrolling itself once its press-and-hold delay activates, so plain
      // touches on the list still scroll the page.
      // highlighted: the same green as a chosen pool card, so "it landed
      // here" reads as the same state.
      className={`flex cursor-grab touch-manipulation flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2 py-2 text-sm select-none transition-colors ${
        highlighted ? "border-green-700 bg-green-50" : "border-line bg-surface"
      } ${isDragging ? "z-10 shadow-md" : ""}`}
    >
      <span
        ref={setActivatorNodeRef}
        {...attributes}
        aria-label={`${name}, rank ${index + 1}. Drag to reorder.`}
        className="px-1 text-ink-soft"
      >
        ⠿
      </span>
      <span className="w-6 shrink-0 text-center text-xs font-semibold text-green-800">#{index + 1}</span>
      <span className="min-w-0 flex-1 basis-32 text-ink">{name}</span>
      <span className="ml-auto flex items-center gap-1">
        {isEthics ? null : (
          <span role="group" aria-label={`Your position on ${name}`} className="flex rounded-md border border-line">
            {(["support", "oppose"] as const).map((direction) => (
              <button
                key={direction}
                type="button"
                disabled={disabled}
                aria-pressed={row.direction === direction}
                onClick={() => onChange({ direction })}
                className={`px-2 py-0.5 text-xs first:rounded-l-md last:rounded-r-md disabled:opacity-50 ${
                  row.direction === direction
                    ? direction === "support"
                      ? "bg-green-700 text-white"
                      : "bg-red-700 text-white"
                    : "text-ink-soft hover:bg-surface"
                }`}
              >
                {direction === "support" ? "Support" : "Oppose"}
              </button>
            ))}
          </span>
        )}
        <button
          type="button"
          disabled={disabled}
          aria-pressed={row.hard_veto}
          aria-label={`${vetoLabel} (${name})`}
          title={vetoLabel}
          onClick={() => onChange({ hard_veto: !row.hard_veto })}
          className={`rounded-md border px-2 py-0.5 text-xs disabled:opacity-50 ${
            row.hard_veto
              ? "border-rausch-dark bg-rausch-dark text-white"
              : "border-line text-ink-soft hover:border-rausch-dark"
          }`}
        >
          {isEthics ? "Skip candidate if negative record" : "Must"}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="px-2 text-ink-soft hover:text-rausch-dark disabled:opacity-30"
        >
          ×
        </button>
      </span>
    </li>
  );
}
