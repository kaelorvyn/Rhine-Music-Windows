import { Oi } from "./music-entry-lettering";
import { entryFrame, rc, type EntryFrame } from "./music-entry-timeline";

/** SVG 命名空间（压缩版的 Di）。 */
const Di = "http://www.w3.org/2000/svg";

/**
 * 圆弧路径拼装（压缩版的 Fi）：把「半径 + 起角 + 扫角」写成 SVG 的 d。
 * sweep >= 2π 附近时用两段大弧拼成整圆，和压缩版同一个判断。
 */
const Fi = (radius: number, start: number, sweep: number, cx = 960, cy = 540): string => {
  const at = (angle: number) => `${cx + Math.cos(angle) * radius},${cy + Math.sin(angle) * radius}`;
  return sweep >= Math.PI * 1.999
    ? `M${at(start)}A${radius},${radius} 0 1 1 ${at(start + Math.PI)}A${radius},${radius} 0 1 1 ${at(start + Math.PI * 2)}`
    : `M${at(start)}A${radius},${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${at(start + sweep)}`;
};

/**
 * 进入应用动画 · 胶片渲染器。
 * 这是从预览版压缩 JS「oc ffilm 179292..186860」逐段移植的 class oc：
 * 构造期的查询清单、SVG 元素创建顺序、属性写入顺序与 renderScan 逻辑都保持原样；
 * update(elapsedSeconds) 每帧把时间轴算出来的数值写进 DOM。
 */
export class EntryFilm {
  private readonly stage: HTMLElement;
  private readonly nodes = new Map<string, HTMLElement>();
  private contour!: SVGPathElement;
  private letters!: SVGTextElement;
  private logoGlyphs!: SVGTSpanElement[];
  private plus!: SVGPathElement;
  private minus!: SVGPathElement;
  private brandLines!: HTMLElement[];
  private scanPaths!: SVGPathElement[];
  private orbitDots!: SVGCircleElement[];
  private core!: SVGCircleElement;
  private satellites!: SVGCircleElement[];
  private caps!: SVGCircleElement[];
  private companyInk!: HTMLElement[];
  private poweredHTML!: string;
  private accessLettering!: Oi;
  private authLettering!: Oi;

  constructor(stage: HTMLElement) {
    this.stage = stage;
    [
      ".access-text",
      ".boot-logo",
      ".auth-status",
      "#auth-message",
      ".scan",
      ".scan > span",
      ".welcome",
      ".welcome-heading",
      ".welcome-panel",
      ".welcome-company",
      ".welcome-highlight",
      ".welcome-database",
      ".welcome-logo",
      ".brand",
      ".powered",
      "#boot-background",
      ".boot-background svg",
      ".boot-white",
    ].forEach((selector) => this.nodes.set(selector, stage.querySelector<HTMLElement>(selector)!));

    // logo：第一个 path 换成 rc 描边（pathLength 1 便于用 dasharray 画进度）
    const logo = stage.querySelector<SVGSVGElement>(".boot-logo svg")!;
    const firstPath = logo.querySelector<SVGPathElement>("path")!;
    this.contour = firstPath;
    this.contour.setAttribute("d", rc);
    this.contour.setAttribute("pathLength", "1");

    // 原 SVG 里的 +/− 组合 path 被拆成两条独立 path，插在它前面，然后把它删掉
    const original = logo.querySelector<SVGPathElement>("path:not([pathLength])")!;
    this.plus = document.createElementNS(Di, "path");
    this.plus.setAttribute("d", "M44 70h50M69 45v50");
    this.minus = document.createElementNS(Di, "path");
    this.minus.setAttribute("d", "M219 70h44");
    [this.plus, this.minus].forEach((path) => {
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "15");
      logo.insertBefore(path, original);
    });
    original.remove();

    // 字母逐个 tspan，配合 logoLetters 阈值做逐字显影
    this.letters = logo.querySelector<SVGTextElement>("text")!;
    this.letters.setAttribute("text-anchor", "middle");
    this.letters.setAttribute("x", "155");
    this.letters.style.whiteSpace = "pre";
    this.logoGlyphs = Array.from("RHINE MUSIC", (glyph) => {
      const span = document.createElementNS(Di, "tspan");
      span.textContent = glyph;
      span.style.opacity = "0";
      return span;
    });
    this.letters.replaceChildren(...this.logoGlyphs);

    this.brandLines = Array.from(stage.querySelector(".brand")!.children) as HTMLElement[];
    this.scanPaths = Array.from(stage.querySelectorAll<SVGPathElement>(".scan path"));
    this.orbitDots = Array.from(stage.querySelectorAll<SVGCircleElement>(".scan .orbit-dot"));
    this.core = stage.querySelector<SVGCircleElement>(".scan .scan-core")!;
    this.core.setAttribute("cx", "959.5");
    this.core.setAttribute("cy", "539.5");

    // 六颗卫星点插在核心圆之前，两个扫角端帽追加在其后
    this.satellites = Array.from({ length: 6 }, () => {
      const dot = document.createElementNS(Di, "circle");
      dot.classList.add("satellite-dot");
      dot.setAttribute("fill", "#080a08");
      dot.setAttribute("stroke", "none");
      this.core.parentElement!.insertBefore(dot, this.core);
      return dot;
    });
    this.caps = ["#080a08", "#fff"].map((fill) => {
      const cap = document.createElementNS(Di, "circle");
      cap.setAttribute("fill", fill);
      cap.setAttribute("stroke", "none");
      this.core.parentElement!.appendChild(cap);
      return cap;
    });

    // .welcome-company 的两个 strong 各包一层 span，方便单独改不透明度
    this.companyInk = Array.from(stage.querySelectorAll<HTMLElement>(".welcome-company strong"));
    this.companyInk.forEach((strong) => {
      const span = document.createElement("span");
      span.textContent = strong.textContent;
      strong.replaceChildren(span);
    });

    this.poweredHTML = this.el(".powered").innerHTML;

    new Oi(this.brandLines[0], ["brand"]).setText("RHINE MUSIC");
    this.accessLettering = new Oi(this.el(".access-text"), ["access"]);
    this.authLettering = new Oi(this.el("#auth-message"), [
      "identity",
      "request",
      "processing",
      "processingGlitch",
    ]);
    for (const [selector, tag, text] of [
      [".scan > span", "permission", "PREPARING YOUR MUSIC"],
      [".welcome-heading", "welcome", "WELCOME TO"],
      [".welcome-database", "database", "MUSIC ARCHIVE"],
    ] as const) {
      new Oi(this.el(selector), [tag]).setText(text);
    }
    this.companyInk.forEach((ink) =>
      new Oi(ink.querySelector("span")!, ["company"]).setText("RHINE MUSIC"),
    );
  }

  private el(selector: string): HTMLElement {
    return this.nodes.get(selector)!;
  }

  private opacity(selector: string, value: number): void {
    this.el(selector).style.opacity = String(Number(value));
  }

  update(elapsedSeconds: number): EntryFrame {
    const frame = entryFrame(elapsedSeconds);
    const t = frame.t;
    this.stage.dataset.bootFrame = String(frame.f);

    // 状态行
    this.accessLettering.setText(frame.access);
    this.opacity(".access-text", frame.accessOpacity);

    // logo：位移、描边进度、字母阈值、+ / − 符号
    this.opacity(".boot-logo", frame.logoOpacity);
    this.el(".boot-logo").style.transform = `translate(${frame.logo.offsetX}px, 1px)`;
    this.contour.style.strokeDasharray = `${frame.logo.length} ${1 - frame.logo.length}`;
    this.contour.style.strokeDashoffset = String(-frame.logo.start);
    this.contour.setAttribute("stroke-width", String(frame.logo.strokeWidth));
    this.logoGlyphs.forEach((glyph, index) => {
      glyph.style.opacity = index < frame.logoLetters.length ? "1" : "0";
    });
    this.plus.style.opacity = this.minus.style.opacity = frame.logo.symbolScale > 0 ? "1" : "0";
    this.plus.setAttribute(
      "transform",
      `translate(${frame.logo.plusX} 70) rotate(${frame.logo.plusAngle}) scale(${frame.logo.symbolScale}) translate(-69 -70)`,
    );
    this.minus.setAttribute("d", `M${-frame.logo.minusWidth / 2} 0h${frame.logo.minusWidth}`);
    this.minus.setAttribute(
      "transform",
      `translate(${frame.logo.minusX} 70) scale(${frame.logo.symbolScale})`,
    );

    // 认证状态行
    this.opacity(".auth-status", frame.authOpacity);
    this.authLettering.setText(frame.auth);

    // 左上 brand 三行
    this.opacity(".brand", 1);
    this.el(".brand").style.transform = "none";
    this.brandLines.forEach((line, index) => {
      line.style.opacity = String(frame.brand[index].opacity);
      line.style.transform = `translateX(${frame.brand[index].x}px)`;
    });

    // 右下 powered：按字母数裁切
    this.opacity(".powered", frame.poweredLetters > 0 ? 1 : 0);
    this.el(".powered").style.clipPath = `inset(0 ${100 * (1 - frame.poweredLetters / 19)}% 0 0)`;

    // 扫描环
    this.opacity(".scan", frame.scanVisible ? 1 : 0);
    if (frame.scanVisible) this.renderScan(frame);

    // welcome 卡组
    this.opacity(".welcome", frame.welcomeVisible ? frame.welcomeOpacity : 0);
    this.el(".welcome").style.transform = `scale(${frame.welcomeScale})`;
    this.el(".welcome").style.filter =
      `blur(${frame.exitBlur}px) invert(${frame.exit * 0.22}) sepia(${frame.exit}) ` +
      `saturate(${1 + frame.exit * 5}) hue-rotate(${frame.exit * 115}deg)`;
    this.opacity(".welcome-panel", frame.welcomePanel);
    this.opacity(".welcome-heading", 1);
    this.el(".welcome-heading").style.color =
      `rgb(${255 * (1 - frame.welcomeInk)} ${255 * (1 - frame.welcomeInk)} ${255 * (1 - frame.welcomeInk)})`;
    this.opacity(".welcome-company", frame.companyVisible ? 1 : 0);
    this.el(".welcome-company").style.opacity = String(
      frame.companyVisible ? (frame.companyMask ? 0.65 : 1) : 0,
    );
    this.companyInk[1].querySelector("span")!.style.opacity = frame.companyMask ? ".06" : "1";
    this.el(".welcome-highlight").style.clipPath = `inset(0 ${100 * (1 - frame.highlight)}% 0 0)`;
    this.opacity(".welcome-database", frame.databaseOpacity);
    this.opacity(".welcome-logo", frame.welcomeLogo ? 1 : 0);

    // 纸底与收尾白闪
    this.opacity("#boot-background", frame.backgroundOpacity);
    this.opacity(".boot-white", frame.white);
    this.el(".boot-background svg").style.transform =
      `translate(${Math.sin(t * 0.16) * 18}px, ${-(t - 6) * 5}px) scale(1.08)`;

    return frame;
  }

  private renderScan(frame: EntryFrame): void {
    const { scan } = frame;
    const radius = scan.radius;
    const group = this.scanPaths[0].parentElement!;
    group.setAttribute(
      "transform",
      `translate(960 540) scale(${frame.ringScale}) translate(-960 -540)`,
    );
    group.style.opacity = String(frame.ringOpacity);
    group.style.filter = `blur(${frame.ringBlur}px)`;

    this.scanPaths[0].setAttribute("d", Fi(radius, scan.outerStart, scan.outerSweep));
    this.scanPaths[0].setAttribute("stroke-width", "2.4");
    this.scanPaths[1].setAttribute("d", Fi(scan.whiteRadius, scan.whiteStart, scan.whiteSweep));
    this.scanPaths[1].setAttribute("stroke-width", "4");

    const innerStart = scan.innerStart;
    this.scanPaths[2].setAttribute("d", Fi(scan.innerRadius, innerStart, scan.innerSweep));
    this.scanPaths[3].setAttribute(
      "d",
      Fi(scan.innerRadius, innerStart + Math.PI, scan.innerSweep),
    );

    frame.scanOrbit.sides.forEach((side, index) => {
      this.scanPaths[index + 4].setAttribute(
        "d",
        Fi(side.radius, side.start, side.sweep, side.x, side.y),
      );
      this.scanPaths[index + 4].style.opacity = frame.scanOrbit.sideVisible ? "1" : "0";
    });

    frame.scanOrbit.satellites.forEach((satellite, index) => {
      const dot = this.satellites[index];
      dot.setAttribute("cx", String(satellite.x));
      dot.setAttribute("cy", String(satellite.y));
      dot.setAttribute("r", String(satellite.radius));
    });

    this.core.style.opacity = frame.ornament ? "1" : "0";
    this.core.setAttribute("r", String(frame.coreRadius));

    const orbit = scan.orbit;
    this.orbitDots.forEach((dot, index) => {
      dot.setAttribute("cx", String(960 + Math.cos(orbit + index * Math.PI) * scan.orbitRadius));
      dot.setAttribute("cy", String(540 + Math.sin(orbit + index * Math.PI) * scan.orbitRadius));
      dot.setAttribute("r", String(scan.dotRadius));
    });

    this.caps.forEach((cap, index) => {
      const angle = index ? scan.whiteStart : scan.outerStart + scan.outerSweep;
      const capRadius = index ? scan.whiteRadius : radius;
      cap.setAttribute("cx", String(960 + Math.cos(angle) * capRadius));
      cap.setAttribute("cy", String(540 + Math.sin(angle) * capRadius));
      cap.setAttribute("r", String(index ? scan.whiteCap : scan.blackCap));
    });

    this.opacity(".scan > span", frame.permissionOpacity);
    this.el(".scan > span").style.letterSpacing = `${frame.scanTracking}px`;
    this.el(".scan > span").style.setProperty("--boot-phrase-tracking", `${frame.scanTracking}px`);
    this.el(".scan > span").style.fontSize = `${frame.scanFont}px`;
  }

  reset(): void {
    [".brand", ".powered"].forEach((selector) => this.el(selector).removeAttribute("style"));
    this.brandLines.forEach((line) => line.removeAttribute("style"));
    this.el(".powered").innerHTML = this.poweredHTML;
    this.opacity("#boot-background", 0);
  }
}
