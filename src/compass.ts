// ==============================================
// COMPASS + 2D / 3D VIEW CONTROL
// ==============================================
//
// A map-app style compass for the bottom-right corner:
//   - the needle turns with the map's rotation and leans with its tilt
//   - click it to snap back to north-up and flat
//   - drag it sideways to rotate, up / down to tilt
//   - the 3D / 2D button below tilts the view in or flattens it
//
// Also the map's mouse gestures (section C3), replacing MapLibre's own:
//   - shift + left drag   rotate (sideways) and tilt (up / down)
//   - ctrl + left drag    draw a box to zoom into
// Right-click no longer rotates.
//
// Replaces MapLibre's built-in compass button (script.ts hides that one).
// Loads before script.js.


// ==============================================
// C1. CONFIG
// ==============================================

// Tilt used by the 3D button
const COMPASS_3D_PITCH = 60;

// Drag sensitivity: degrees per pixel
const COMPASS_ROTATE_PER_PX = 0.8;
const COMPASS_TILT_PER_PX = 0.5;

// Shift + drag speed on the map, in degrees per pixel. Lower = slower.
// Sign sets direction: positive rotate = drag left turns the map clockwise
const DRAG_ROTATE_PER_PX = 0.2;
const DRAG_TILT_PER_PX = 0.25;

// A press that moves less than this is a click, not a drag
const COMPASS_CLICK_SLOP_PX = 4;


// ==============================================
// C2. CONTROL
// ==============================================

class ViewCompassControl {

    private container: HTMLElement | null = null;
    private needle: HTMLElement | null = null;
    private compassButton: HTMLButtonElement | null = null;
    private viewButton: HTMLButtonElement | null = null;
    private ctrlMap: MapInstance | null = null;
    private readonly onMove = () => this.update();

    onAdd(targetMap: MapInstance): HTMLElement {

        this.ctrlMap = targetMap;

        const container = document.createElement("div");
        container.className = "maplibregl-ctrl maplibregl-ctrl-group view-compass";

        // COMPASS BUTTON: north half red, south half grey
        const compass = document.createElement("button");
        compass.type = "button";
        compass.className = "view-compass-dial";
        compass.title = "Click to reset north and tilt. Drag to rotate / tilt";
        compass.setAttribute("aria-label", "Reset view to north, flat");
        compass.innerHTML = `
            <span class="view-compass-needle">
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                    <polygon points="12,2 16,12 8,12" fill="var(--red)"/>
                    <polygon points="12,22 16,12 8,12" fill="#c8d2dc"/>
                    <circle cx="12" cy="12" r="1.6" fill="var(--panel)"/>
                </svg>
            </span>`;

        // 2D / 3D BUTTON
        const view = document.createElement("button");
        view.type = "button";
        view.className = "view-compass-mode";

        container.append(compass, view);

        this.container = container;
        this.compassButton = compass;
        this.needle = compass.querySelector(".view-compass-needle");
        this.viewButton = view;

        this.bindDrag(compass);

        view.addEventListener("click", () => this.toggleView());

        targetMap.on("move", this.onMove);

        this.update();

        return container;
    }

    onRemove(): void {

        if (this.ctrlMap) this.ctrlMap.off("move", this.onMove);

        this.container?.remove();

        this.ctrlMap = null;
    }

    // Keep the needle and button label in step with the camera
    private update(): void {

        const m = this.ctrlMap;

        if (!m || !this.needle || !this.compassButton || !this.viewButton) return;

        const bearing = m.getBearing();
        const pitch = m.getPitch();

        this.needle.style.transform = `rotateX(${pitch}deg) rotate(${-bearing}deg)`;

        const isReset = Math.abs(bearing) < 0.5 && pitch < 0.5;

        this.compassButton.classList.toggle("is-reset", isReset);

        const tilted = pitch >= 5;

        this.viewButton.textContent = tilted ? "2D" : "3D";
        this.viewButton.title = tilted ? "Flatten the view" : "Tilt the view into 3D";
    }

    private resetView(): void {

        this.ctrlMap?.easeTo({ bearing: 0, pitch: 0, duration: 600 });
    }

    private toggleView(): void {

        const m = this.ctrlMap;

        if (!m) return;

        if (m.getPitch() >= 5) {
            m.easeTo({ pitch: 0, duration: 600 });
        } else {
            m.easeTo({ pitch: COMPASS_3D_PITCH, duration: 600 });
        }
    }

    // Press-and-drag on the dial rotates / tilts; a plain click resets
    private bindDrag(dial: HTMLElement): void {

        let startX = 0;
        let startY = 0;
        let startBearing = 0;
        let startPitch = 0;
        let dragging = false;
        let pointerId: number | null = null;

        dial.addEventListener("pointerdown", (event: PointerEvent) => {

            if (!this.ctrlMap || event.button !== 0) return;

            pointerId = event.pointerId;
            dial.setPointerCapture(pointerId);

            startX = event.clientX;
            startY = event.clientY;
            startBearing = this.ctrlMap.getBearing();
            startPitch = this.ctrlMap.getPitch();
            dragging = false;

            this.ctrlMap.stop();

            event.preventDefault();
        });

        dial.addEventListener("pointermove", (event: PointerEvent) => {

            if (pointerId !== event.pointerId || !this.ctrlMap) return;

            const dx = event.clientX - startX;
            const dy = event.clientY - startY;

            if (!dragging && Math.hypot(dx, dy) < COMPASS_CLICK_SLOP_PX) return;

            dragging = true;
            dial.classList.add("is-dragging");

            this.ctrlMap.jumpTo({
                // Same direction as right-click dragging the map
                bearing: startBearing + dx * COMPASS_ROTATE_PER_PX,
                // Drag up to tilt further, like pushing the horizon away
                pitch: Math.max(0, startPitch - dy * COMPASS_TILT_PER_PX)
            });
        });

        const finish = (event: PointerEvent) => {

            if (pointerId !== event.pointerId) return;

            if (dial.hasPointerCapture(event.pointerId)) {
                dial.releasePointerCapture(event.pointerId);
            }

            pointerId = null;
            dial.classList.remove("is-dragging");

            if (!dragging && event.type === "pointerup") this.resetView();

            dragging = false;
        };

        dial.addEventListener("pointerup", finish);
        dial.addEventListener("pointercancel", finish);

        // Keyboard users: Enter / Space fires "click" with no pointer events
        dial.addEventListener("click", (event: MouseEvent) => {
            if (event.detail === 0) this.resetView();
        });
    }
}


// ==============================================
// C3. MOUSE GESTURES
// ==============================================
//
// Listens on the map's outer element in the capture phase, so a shift- or
// ctrl-press never reaches MapLibre (which would otherwise start panning).

type GestureKind = "rotate" | "box";

function initializeMouseGestures(): void {

    if (!map) return;

    const container = map.getContainer();
    const canvasBox = map.getCanvasContainer();

    let kind: GestureKind | null = null;
    let startX = 0;
    let startY = 0;
    let startBearing = 0;
    let startPitch = 0;
    let moved = false;
    let box: HTMLDivElement | null = null;

    // Window position -> MapLibre screen coordinates (relative to the map)
    const toPoint = (clientX: number, clientY: number): [number, number] => {
        const rect = canvasBox.getBoundingClientRect();
        return [clientX - rect.left, clientY - rect.top];
    };

    const finish = (cancelled: boolean, event?: MouseEvent) => {

        if (!kind) return;

        if (box) {

            box.remove();
            box = null;

            if (!cancelled && moved && event) {

                const p0 = toPoint(startX, startY);
                const p1 = toPoint(event.clientX, event.clientY);

                // Ignore a box too thin to mean anything
                if (Math.abs(p1[0] - p0[0]) > 4 && Math.abs(p1[1] - p0[1]) > 4) {
                    map.fitScreenCoordinates(p0, p1, map.getBearing(), { linear: true });
                }
            }
        }

        container.classList.remove("gesture-rotating", "gesture-boxing");
        kind = null;

        // The browser fires the drag's own click straight after mouseup; clear
        // the flag after that, so a release off the map can't eat a later click
        setTimeout(() => { moved = false; }, 0);

        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("blur", onBlur);
    };

    const onMove = (event: MouseEvent) => {

        if (!kind) return;

        const dx = event.clientX - startX;
        const dy = event.clientY - startY;

        if (!moved && Math.hypot(dx, dy) < COMPASS_CLICK_SLOP_PX) return;

        moved = true;

        if (kind === "rotate") {

            map.jumpTo({
                bearing: startBearing + dx * DRAG_ROTATE_PER_PX,
                // Drag up to tilt further
                pitch: Math.max(0, startPitch - dy * DRAG_TILT_PER_PX)
            });

            return;
        }

        if (!box) {
            box = document.createElement("div");
            box.className = "gesture-zoom-box";
            canvasBox.appendChild(box);
        }

        const [x0, y0] = toPoint(startX, startY);
        const [x1, y1] = toPoint(event.clientX, event.clientY);

        box.style.left = `${Math.min(x0, x1)}px`;
        box.style.top = `${Math.min(y0, y1)}px`;
        box.style.width = `${Math.abs(x1 - x0)}px`;
        box.style.height = `${Math.abs(y1 - y0)}px`;
    };

    const onUp = (event: MouseEvent) => {

        if (event.button === 0) finish(false, event);
    };

    // Escape cancels a box zoom part-way
    const onKey = (event: KeyboardEvent) => {

        if (event.key === "Escape") finish(true);
    };

    const onBlur = () => finish(true);

    container.addEventListener("mousedown", (event: MouseEvent) => {

        if (event.button !== 0 || kind) return;

        // Only gestures on the map itself, not on its buttons or popups
        if (!canvasBox.contains(event.target as Node)) return;

        if (event.shiftKey && !event.ctrlKey) kind = "rotate";
        else if (event.ctrlKey && !event.shiftKey) kind = "box";
        else return;

        // Keep MapLibre from panning, and the browser from selecting text
        event.stopPropagation();
        event.preventDefault();

        startX = event.clientX;
        startY = event.clientY;
        startBearing = map.getBearing();
        startPitch = map.getPitch();
        moved = false;

        map.stop();

        container.classList.add(kind === "rotate" ? "gesture-rotating" : "gesture-boxing");

        window.addEventListener("mousemove", onMove, true);
        window.addEventListener("mouseup", onUp, true);
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("blur", onBlur);

    }, true);

    // A shift / ctrl drag shouldn't also count as a click on the map
    // (that would open location inspection where the drag ended)
    container.addEventListener("click", (event: MouseEvent) => {

        if (!moved) return;

        moved = false;
        event.stopPropagation();

    }, true);
}
