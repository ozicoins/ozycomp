import { al as groupD8, a0 as bgr2rgb, an as multiplyHexColors, M as Matrix, l as ExtensionType, w as Graphics, au as warn, ar as shapeBuilders, a1 as buildLine, i as Color, T as Texture, ae as generateTextureMatrix, F as FillGradient, m as FillPattern, h as CanvasSource, D as DOMAdapter, A as AbstractRenderer, z as RendererType, aa as extensions } from "./OfficeFloor-BwoXLG0T.js";
import { b as RenderTargetSystem, c as SharedSystems, a as BlendModePipe, B as BatcherPipe, d as SpritePipe, R as RenderGroupPipe, A as AlphaMaskPipe, C as CustomRenderPipe } from "./RenderTargetSystem-DswfCb17.js";
import { a as canvasUtils, c as canUseNewCanvasBlendModes } from "./canvasUtils-C0FY3uOY.js";
import "./index-CsK_GEYj.js";
import "./global-eDtrx50m.js";
import "./portraitArt-Bz9wz1UV.js";
import "./index-CYoBaPLy.js";
import "./PuckFace-CCZUmqjS.js";
import "./puck-HlPOn73L.js";
import "./Filter-Bm0229Pl.js";
const _CanvasBatchAdaptor = class _CanvasBatchAdaptor2 {
  static _getPatternRepeat(addressModeU, addressModeV) {
    const repeatU = addressModeU && addressModeU !== "clamp-to-edge";
    const repeatV = addressModeV && addressModeV !== "clamp-to-edge";
    if (repeatU && repeatV) return "repeat";
    if (repeatU) return "repeat-x";
    if (repeatV) return "repeat-y";
    return "no-repeat";
  }
  start(batchPipe, geometry, shader) {
  }
  execute(batchPipe, batch) {
    const elements = batch.elements;
    if (!elements || !elements.length) return;
    const renderer = batchPipe.renderer;
    const contextSystem = renderer.canvasContext;
    const context = contextSystem.activeContext;
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (!element.packAsQuad) continue;
      const quad = element;
      const texture = quad.texture;
      const source = texture ? canvasUtils.getCanvasSource(texture) : null;
      if (!source) continue;
      const textureStyle = texture.source.style;
      const smoothProperty = contextSystem.smoothProperty;
      const shouldSmooth = textureStyle.scaleMode !== "nearest";
      if (context[smoothProperty] !== shouldSmooth) {
        context[smoothProperty] = shouldSmooth;
      }
      contextSystem.setBlendMode(batch.blendMode);
      const globalColor = renderer.globalUniforms.globalUniformData?.worldColor ?? 4294967295;
      const argb = quad.color;
      const globalAlpha = (globalColor >>> 24 & 255) / 255;
      const quadAlpha = (argb >>> 24 & 255) / 255;
      const filterAlpha = renderer.filter?.alphaMultiplier ?? 1;
      const alpha = globalAlpha * quadAlpha * filterAlpha;
      if (alpha <= 0) continue;
      context.globalAlpha = alpha;
      const globalTint = globalColor & 16777215;
      const quadTint = argb & 16777215;
      const tint = bgr2rgb(multiplyHexColors(quadTint, globalTint));
      const frame = texture.frame;
      const repeatU = textureStyle.addressModeU ?? textureStyle.addressMode;
      const repeatV = textureStyle.addressModeV ?? textureStyle.addressMode;
      const repeat = _CanvasBatchAdaptor2._getPatternRepeat(repeatU, repeatV);
      const resolution = texture.source._resolution ?? texture.source.resolution ?? 1;
      const isFromCachedRenderGroup = quad.renderable?.renderGroup?.isCachedAsTexture;
      const sx = frame.x * resolution;
      const sy = frame.y * resolution;
      const sw = frame.width * resolution;
      const sh = frame.height * resolution;
      const bounds = quad.bounds;
      const isRootTarget = renderer.renderTarget.renderTarget.isRoot;
      const dx = bounds.minX;
      const dy = bounds.minY;
      const dw = bounds.maxX - bounds.minX;
      const dh = bounds.maxY - bounds.minY;
      const rotate = texture.rotate;
      const uvs = texture.uvs;
      const uvMin = Math.min(uvs.x0, uvs.x1, uvs.x2, uvs.x3, uvs.y0, uvs.y1, uvs.y2, uvs.y3);
      const uvMax = Math.max(uvs.x0, uvs.x1, uvs.x2, uvs.x3, uvs.y0, uvs.y1, uvs.y2, uvs.y3);
      const needsRepeat = repeat !== "no-repeat" && (uvMin < 0 || uvMax > 1);
      const willUseProcessedCanvas = !needsRepeat && (tint !== 16777215 || rotate);
      const applyRotateTransform = rotate && !willUseProcessedCanvas;
      if (applyRotateTransform) {
        _CanvasBatchAdaptor2._tempPatternMatrix.copyFrom(quad.transform);
        groupD8.matrixAppendRotationInv(
          _CanvasBatchAdaptor2._tempPatternMatrix,
          rotate,
          dx,
          dy,
          dw,
          dh
        );
        contextSystem.setContextTransform(
          _CanvasBatchAdaptor2._tempPatternMatrix,
          quad.roundPixels === 1,
          void 0,
          isFromCachedRenderGroup && isRootTarget
        );
      } else {
        contextSystem.setContextTransform(
          quad.transform,
          quad.roundPixels === 1,
          void 0,
          isFromCachedRenderGroup && isRootTarget
        );
      }
      const drawX = applyRotateTransform ? 0 : dx;
      const drawY = applyRotateTransform ? 0 : dy;
      const drawW = dw;
      const drawH = dh;
      if (needsRepeat) {
        let patternSource = source;
        const canTint = tint !== 16777215 && !rotate;
        const fitsFrame = frame.width <= texture.source.width && frame.height <= texture.source.height;
        if (canTint && fitsFrame) {
          patternSource = canvasUtils.getTintedCanvas({ texture }, tint);
        }
        const pattern = context.createPattern(patternSource, repeat);
        if (!pattern) continue;
        const denomX = drawW;
        const denomY = drawH;
        if (denomX === 0 || denomY === 0) continue;
        const invDx = 1 / denomX;
        const invDy = 1 / denomY;
        const a = (uvs.x1 - uvs.x0) * invDx;
        const b = (uvs.y1 - uvs.y0) * invDx;
        const c = (uvs.x3 - uvs.x0) * invDy;
        const d = (uvs.y3 - uvs.y0) * invDy;
        const tx = uvs.x0 - a * drawX - c * drawY;
        const ty = uvs.y0 - b * drawX - d * drawY;
        const pixelWidth = texture.source.pixelWidth;
        const pixelHeight = texture.source.pixelHeight;
        _CanvasBatchAdaptor2._tempPatternMatrix.set(
          a * pixelWidth,
          b * pixelHeight,
          c * pixelWidth,
          d * pixelHeight,
          tx * pixelWidth,
          ty * pixelHeight
        );
        canvasUtils.applyPatternTransform(pattern, _CanvasBatchAdaptor2._tempPatternMatrix);
        context.fillStyle = pattern;
        context.fillRect(drawX, drawY, drawW, drawH);
      } else {
        const needsProcessing = tint !== 16777215 || rotate;
        const processedSource = needsProcessing ? canvasUtils.getTintedCanvas({ texture }, tint) : source;
        const isProcessed = processedSource !== source;
        context.drawImage(
          processedSource,
          isProcessed ? 0 : sx,
          isProcessed ? 0 : sy,
          isProcessed ? processedSource.width : sw,
          isProcessed ? processedSource.height : sh,
          drawX,
          drawY,
          drawW,
          drawH
        );
      }
    }
  }
};
_CanvasBatchAdaptor._tempPatternMatrix = new Matrix();
_CanvasBatchAdaptor.extension = {
  type: [
    ExtensionType.CanvasPipesAdaptor
  ],
  name: "batch"
};
let CanvasBatchAdaptor = _CanvasBatchAdaptor;
class CanvasColorMaskPipe {
  constructor(renderer) {
    this._colorStack = [];
    this._colorStackIndex = 0;
    this._currentColor = 0;
    this._renderer = renderer;
  }
  buildStart() {
    this._colorStack[0] = 15;
    this._colorStackIndex = 1;
    this._currentColor = 15;
  }
  push(mask, _container, instructionSet) {
    this._renderer.renderPipes.batch.break(instructionSet);
    const colorStack = this._colorStack;
    colorStack[this._colorStackIndex] = colorStack[this._colorStackIndex - 1] & mask.mask;
    const currentColor = this._colorStack[this._colorStackIndex];
    if (currentColor !== this._currentColor) {
      this._currentColor = currentColor;
      instructionSet.add({
        renderPipeId: "colorMask",
        colorMask: currentColor,
        canBundle: false
      });
    }
    this._colorStackIndex++;
  }
  pop(_mask, _container, instructionSet) {
    this._renderer.renderPipes.batch.break(instructionSet);
    const colorStack = this._colorStack;
    this._colorStackIndex--;
    const currentColor = colorStack[this._colorStackIndex - 1];
    if (currentColor !== this._currentColor) {
      this._currentColor = currentColor;
      instructionSet.add({
        renderPipeId: "colorMask",
        colorMask: currentColor,
        canBundle: false
      });
    }
  }
  execute(_instruction) {
  }
  destroy() {
    this._renderer = null;
    this._colorStack = null;
  }
}
CanvasColorMaskPipe.extension = {
  type: [
    ExtensionType.CanvasPipes
  ],
  name: "colorMask"
};
function buildRoundedRectPath$1(context, x, y, width, height, radius) {
  radius = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
}
function buildShapePath$1(context, shape) {
  switch (shape.type) {
    case "rectangle": {
      const rect = shape;
      context.rect(rect.x, rect.y, rect.width, rect.height);
      break;
    }
    case "roundedRectangle": {
      const rect = shape;
      buildRoundedRectPath$1(context, rect.x, rect.y, rect.width, rect.height, rect.radius);
      break;
    }
    case "circle": {
      const circle = shape;
      context.moveTo(circle.x + circle.radius, circle.y);
      context.arc(circle.x, circle.y, circle.radius, 0, Math.PI * 2);
      break;
    }
    case "ellipse": {
      const ellipse = shape;
      if (context.ellipse) {
        context.moveTo(ellipse.x + ellipse.halfWidth, ellipse.y);
        context.ellipse(ellipse.x, ellipse.y, ellipse.halfWidth, ellipse.halfHeight, 0, 0, Math.PI * 2);
      } else {
        context.save();
        context.translate(ellipse.x, ellipse.y);
        context.scale(ellipse.halfWidth, ellipse.halfHeight);
        context.moveTo(1, 0);
        context.arc(0, 0, 1, 0, Math.PI * 2);
        context.restore();
      }
      break;
    }
    case "triangle": {
      const tri = shape;
      context.moveTo(tri.x, tri.y);
      context.lineTo(tri.x2, tri.y2);
      context.lineTo(tri.x3, tri.y3);
      context.closePath();
      break;
    }
    case "polygon":
    default: {
      const poly = shape;
      const points = poly.points;
      if (!points?.length) break;
      context.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) {
        context.lineTo(points[i], points[i + 1]);
      }
      if (poly.closePath) {
        context.closePath();
      }
      break;
    }
  }
}
function buildStrokeMaskPath(context, shape, strokeStyle) {
  const points = [];
  const vertices = [];
  const indices = [];
  const shapeBuilder = shapeBuilders[shape.type];
  if (!shapeBuilder?.build(shape, points)) return false;
  const close = shape.closePath ?? true;
  buildLine(points, strokeStyle, false, close, vertices, indices);
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 2;
    const i1 = indices[i + 1] * 2;
    const i2 = indices[i + 2] * 2;
    context.moveTo(vertices[i0], vertices[i0 + 1]);
    context.lineTo(vertices[i1], vertices[i1 + 1]);
    context.lineTo(vertices[i2], vertices[i2 + 1]);
    context.closePath();
  }
  return true;
}
function addHolePaths$1(context, holes) {
  if (!holes?.length) return false;
  for (let i = 0; i < holes.length; i++) {
    const hole = holes[i];
    if (!hole?.shape) continue;
    const transform = hole.transform;
    const hasTransform = transform && !transform.isIdentity();
    if (hasTransform) {
      context.save();
      context.transform(transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty);
    }
    buildShapePath$1(context, hole.shape);
    if (hasTransform) {
      context.restore();
    }
  }
  return true;
}
class CanvasStencilMaskPipe {
  constructor(renderer) {
    this._warnedMaskTypes = /* @__PURE__ */ new Set();
    this._canvasMaskStack = [];
    this._renderer = renderer;
  }
  push(mask, _container, instructionSet) {
    this._renderer.renderPipes.batch.break(instructionSet);
    instructionSet.add({
      renderPipeId: "stencilMask",
      action: "pushMaskBegin",
      mask,
      inverse: _container._maskOptions.inverse,
      canBundle: false
    });
  }
  pop(_mask, _container, instructionSet) {
    this._renderer.renderPipes.batch.break(instructionSet);
    instructionSet.add({
      renderPipeId: "stencilMask",
      action: "popMaskEnd",
      mask: _mask,
      inverse: _container._maskOptions.inverse,
      canBundle: false
    });
  }
  execute(instruction) {
    if (instruction.action !== "pushMaskBegin" && instruction.action !== "popMaskEnd") {
      return;
    }
    const canvasRenderer = this._renderer;
    const contextSystem = canvasRenderer.canvasContext;
    const context = contextSystem?.activeContext;
    if (!context) return;
    if (instruction.action === "popMaskEnd") {
      const didClip = this._canvasMaskStack.pop();
      if (didClip) {
        context.restore();
      }
      return;
    }
    if (instruction.inverse) {
      this._warnOnce(
        "inverse",
        "CanvasRenderer: inverse masks are not supported on Canvas2D; ignoring inverse flag."
      );
    }
    const maskContainer = instruction.mask.mask;
    if (!(maskContainer instanceof Graphics)) {
      this._warnOnce(
        "nonGraphics",
        "CanvasRenderer: only Graphics masks are supported in Canvas2D; skipping mask."
      );
      this._canvasMaskStack.push(false);
      return;
    }
    const graphics = maskContainer;
    const instructions = graphics.context?.instructions;
    if (!instructions?.length) {
      this._canvasMaskStack.push(false);
      return;
    }
    context.save();
    contextSystem.setContextTransform(
      graphics.groupTransform,
      (canvasRenderer._roundPixels | graphics._roundPixels) === 1
    );
    context.beginPath();
    let drewPath = false;
    let hasHoles = false;
    for (let i = 0; i < instructions.length; i++) {
      const instructionData = instructions[i];
      const action = instructionData.action;
      if (action !== "fill" && action !== "stroke") continue;
      const data = instructionData.data;
      const shapePath = data?.path?.shapePath;
      if (!shapePath?.shapePrimitives?.length) continue;
      const isStroke = action === "stroke";
      const shapePrimitives = shapePath.shapePrimitives;
      for (let j = 0; j < shapePrimitives.length; j++) {
        const primitive = shapePrimitives[j];
        if (!primitive?.shape) continue;
        const transform = primitive.transform;
        const hasTransform = transform && !transform.isIdentity();
        if (hasTransform) {
          context.save();
          context.transform(transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty);
        }
        if (isStroke && data.style) {
          drewPath = buildStrokeMaskPath(
            context,
            primitive.shape,
            data.style
          ) || drewPath;
        } else {
          buildShapePath$1(context, primitive.shape);
          hasHoles = addHolePaths$1(context, primitive.holes) || hasHoles;
          drewPath = true;
        }
        if (hasTransform) {
          context.restore();
        }
      }
    }
    if (!drewPath) {
      context.restore();
      this._canvasMaskStack.push(false);
      return;
    }
    if (hasHoles) {
      context.clip("evenodd");
    } else {
      context.clip();
    }
    this._canvasMaskStack.push(true);
  }
  destroy() {
    this._renderer = null;
    this._warnedMaskTypes = null;
    this._canvasMaskStack = null;
  }
  _warnOnce(key, message) {
    if (this._warnedMaskTypes.has(key)) return;
    this._warnedMaskTypes.add(key);
    warn(message);
  }
}
CanvasStencilMaskPipe.extension = {
  type: [
    ExtensionType.CanvasPipes
  ],
  name: "stencilMask"
};
const FALLBACK_BLEND = "source-over";
function mapCanvasBlendModesToPixi() {
  const supportsAdvanced = canUseNewCanvasBlendModes();
  const map = /* @__PURE__ */ Object.create(null);
  map.inherit = FALLBACK_BLEND;
  map.none = FALLBACK_BLEND;
  map.normal = "source-over";
  map.add = "lighter";
  map.multiply = supportsAdvanced ? "multiply" : FALLBACK_BLEND;
  map.screen = supportsAdvanced ? "screen" : FALLBACK_BLEND;
  map.overlay = supportsAdvanced ? "overlay" : FALLBACK_BLEND;
  map.darken = supportsAdvanced ? "darken" : FALLBACK_BLEND;
  map.lighten = supportsAdvanced ? "lighten" : FALLBACK_BLEND;
  map["color-dodge"] = supportsAdvanced ? "color-dodge" : FALLBACK_BLEND;
  map["color-burn"] = supportsAdvanced ? "color-burn" : FALLBACK_BLEND;
  map["hard-light"] = supportsAdvanced ? "hard-light" : FALLBACK_BLEND;
  map["soft-light"] = supportsAdvanced ? "soft-light" : FALLBACK_BLEND;
  map.difference = supportsAdvanced ? "difference" : FALLBACK_BLEND;
  map.exclusion = supportsAdvanced ? "exclusion" : FALLBACK_BLEND;
  map.saturation = supportsAdvanced ? "saturation" : FALLBACK_BLEND;
  map.color = supportsAdvanced ? "color" : FALLBACK_BLEND;
  map.luminosity = supportsAdvanced ? "luminosity" : FALLBACK_BLEND;
  map["linear-burn"] = supportsAdvanced ? "color-burn" : FALLBACK_BLEND;
  map["linear-dodge"] = supportsAdvanced ? "color-dodge" : FALLBACK_BLEND;
  map["linear-light"] = supportsAdvanced ? "hard-light" : FALLBACK_BLEND;
  map["pin-light"] = supportsAdvanced ? "hard-light" : FALLBACK_BLEND;
  map["vivid-light"] = supportsAdvanced ? "hard-light" : FALLBACK_BLEND;
  map["hard-mix"] = FALLBACK_BLEND;
  map.negation = supportsAdvanced ? "difference" : FALLBACK_BLEND;
  map["normal-npm"] = map.normal;
  map["add-npm"] = map.add;
  map["screen-npm"] = map.screen;
  map.erase = "destination-out";
  map.subtract = FALLBACK_BLEND;
  map.divide = FALLBACK_BLEND;
  map.min = FALLBACK_BLEND;
  map.max = FALLBACK_BLEND;
  return map;
}
const tempMatrix$1 = new Matrix();
class CanvasContextSystem {
  /**
   * @param renderer - The owning CanvasRenderer.
   */
  constructor(renderer) {
    this.activeResolution = 1;
    this.smoothProperty = "imageSmoothingEnabled";
    this.blendModes = mapCanvasBlendModesToPixi();
    this._activeBlendMode = "normal";
    this._projTransform = null;
    this._outerBlend = false;
    this._warnedBlendModes = /* @__PURE__ */ new Set();
    this._renderer = renderer;
  }
  resolutionChange(resolution) {
    this.activeResolution = resolution;
  }
  /** Initializes the root context and smoothing flag selection. */
  init() {
    const alpha = this._renderer.background.alpha < 1;
    this.rootContext = this._renderer.canvas.getContext(
      "2d",
      { alpha }
    );
    this.activeContext = this.rootContext;
    this.activeResolution = this._renderer.resolution;
    if (!this.rootContext.imageSmoothingEnabled) {
      const rc = this.rootContext;
      if (rc.webkitImageSmoothingEnabled) {
        this.smoothProperty = "webkitImageSmoothingEnabled";
      } else if (rc.mozImageSmoothingEnabled) {
        this.smoothProperty = "mozImageSmoothingEnabled";
      } else if (rc.oImageSmoothingEnabled) {
        this.smoothProperty = "oImageSmoothingEnabled";
      } else if (rc.msImageSmoothingEnabled) {
        this.smoothProperty = "msImageSmoothingEnabled";
      }
    }
  }
  /**
   * Sets the current transform on the active context.
   * @param transform - Transform to apply.
   * @param roundPixels - Whether to round translation to integers.
   * @param localResolution - Optional local resolution multiplier.
   * @param skipGlobalTransform - If true, skip applying the global world transform matrix.
   */
  setContextTransform(transform, roundPixels, localResolution, skipGlobalTransform) {
    const globalTransform = skipGlobalTransform ? Matrix.IDENTITY : this._renderer.globalUniforms.globalUniformData?.worldTransformMatrix || Matrix.IDENTITY;
    let mat = tempMatrix$1;
    mat.copyFrom(globalTransform);
    mat.append(transform);
    const proj = this._projTransform;
    const contextResolution = this.activeResolution;
    localResolution = localResolution || contextResolution;
    if (proj) {
      const finalMat = Matrix.shared;
      finalMat.copyFrom(mat);
      finalMat.prepend(proj);
      mat = finalMat;
    }
    if (roundPixels) {
      this.activeContext.setTransform(
        mat.a * localResolution,
        mat.b * localResolution,
        mat.c * localResolution,
        mat.d * localResolution,
        mat.tx * contextResolution | 0,
        mat.ty * contextResolution | 0
      );
    } else {
      this.activeContext.setTransform(
        mat.a * localResolution,
        mat.b * localResolution,
        mat.c * localResolution,
        mat.d * localResolution,
        mat.tx * contextResolution,
        mat.ty * contextResolution
      );
    }
  }
  /**
   * Clears the current render target, optionally filling with a color.
   * @param clearColor - Color to fill after clearing.
   * @param alpha - Alpha override for the clear color.
   */
  clear(clearColor, alpha) {
    const context = this.activeContext;
    const renderer = this._renderer;
    context.clearRect(0, 0, renderer.width, renderer.height);
    if (clearColor) {
      const color = Color.shared.setValue(clearColor);
      context.globalAlpha = alpha ?? color.alpha;
      context.fillStyle = color.toHex();
      context.fillRect(0, 0, renderer.width, renderer.height);
      context.globalAlpha = 1;
    }
  }
  /**
   * Sets the active blend mode.
   * @param blendMode - Pixi blend mode.
   */
  setBlendMode(blendMode) {
    if (this._activeBlendMode === blendMode) return;
    this._activeBlendMode = blendMode;
    this._outerBlend = false;
    const mappedBlend = this.blendModes[blendMode];
    if (!mappedBlend) {
      if (!this._warnedBlendModes.has(blendMode)) {
        console.warn(
          `CanvasRenderer: blend mode "${blendMode}" is not supported in Canvas2D; falling back to "source-over".`
        );
        this._warnedBlendModes.add(blendMode);
      }
      this.activeContext.globalCompositeOperation = "source-over";
      return;
    }
    this.activeContext.globalCompositeOperation = mappedBlend;
  }
  /** Releases context references. */
  destroy() {
    this.rootContext = null;
    this.activeContext = null;
    this._warnedBlendModes.clear();
  }
}
CanvasContextSystem.extension = {
  type: [
    ExtensionType.CanvasSystem
  ],
  name: "canvasContext"
};
class CanvasLimitsSystem {
  constructor() {
    this.maxTextures = 16;
    this.maxBatchableTextures = 16;
    this.maxUniformBindings = 0;
  }
  init() {
  }
}
CanvasLimitsSystem.extension = {
  type: [
    ExtensionType.CanvasSystem
  ],
  name: "limits"
};
const emptyCanvasStyle = "#808080";
const tempMatrix = new Matrix();
const tempTextureMatrix = new Matrix();
const tempGradientMatrix = new Matrix();
const tempPatternMatrix = new Matrix();
function fillTriangles(context, vertices, indices) {
  context.beginPath();
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 2;
    const i1 = indices[i + 1] * 2;
    const i2 = indices[i + 2] * 2;
    context.moveTo(vertices[i0], vertices[i0 + 1]);
    context.lineTo(vertices[i1], vertices[i1 + 1]);
    context.lineTo(vertices[i2], vertices[i2 + 1]);
    context.closePath();
  }
  context.fill();
}
function colorToHex(color) {
  const clamped = color & 16777215;
  return `#${clamped.toString(16).padStart(6, "0")}`;
}
function buildRoundedRectPath(context, x, y, width, height, radius) {
  radius = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
}
function buildShapePath(context, shape) {
  switch (shape.type) {
    case "rectangle": {
      const rect = shape;
      context.rect(rect.x, rect.y, rect.width, rect.height);
      break;
    }
    case "roundedRectangle": {
      const rect = shape;
      buildRoundedRectPath(context, rect.x, rect.y, rect.width, rect.height, rect.radius);
      break;
    }
    case "circle": {
      const circle = shape;
      context.arc(circle.x, circle.y, circle.radius, 0, Math.PI * 2);
      break;
    }
    case "ellipse": {
      const ellipse = shape;
      if (context.ellipse) {
        context.ellipse(ellipse.x, ellipse.y, ellipse.halfWidth, ellipse.halfHeight, 0, 0, Math.PI * 2);
      } else {
        context.save();
        context.translate(ellipse.x, ellipse.y);
        context.scale(ellipse.halfWidth, ellipse.halfHeight);
        context.arc(0, 0, 1, 0, Math.PI * 2);
        context.restore();
      }
      break;
    }
    case "triangle": {
      const tri = shape;
      context.moveTo(tri.x, tri.y);
      context.lineTo(tri.x2, tri.y2);
      context.lineTo(tri.x3, tri.y3);
      context.closePath();
      break;
    }
    case "polygon":
    default: {
      const poly = shape;
      const points = poly.points;
      if (!points?.length) break;
      context.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) {
        context.lineTo(points[i], points[i + 1]);
      }
      if (poly.closePath) {
        context.closePath();
      }
      break;
    }
  }
}
function addHolePaths(context, holes) {
  if (!holes?.length) return false;
  for (let i = 0; i < holes.length; i++) {
    const hole = holes[i];
    if (!hole?.shape) continue;
    const transform = hole.transform;
    const hasTransform = transform && !transform.isIdentity();
    if (hasTransform) {
      context.save();
      context.transform(transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty);
    }
    buildShapePath(context, hole.shape);
    if (hasTransform) {
      context.restore();
    }
  }
  return true;
}
function getCanvasStyle(style, tint, textureMatrix, currentTransform) {
  const fill = style.fill;
  if (fill instanceof FillGradient) {
    fill.buildGradient();
    const gradientTexture = fill.texture;
    if (gradientTexture) {
      const pattern = canvasUtils.getTintedPattern(gradientTexture, tint);
      const patternMatrix = textureMatrix ? tempPatternMatrix.copyFrom(textureMatrix).scale(gradientTexture.source.pixelWidth, gradientTexture.source.pixelHeight) : tempPatternMatrix.copyFrom(fill.transform);
      if (currentTransform && !style.textureSpace) {
        patternMatrix.append(currentTransform);
      }
      canvasUtils.applyPatternTransform(pattern, patternMatrix);
      return pattern;
    }
  }
  if (fill instanceof FillPattern) {
    const pattern = canvasUtils.getTintedPattern(fill.texture, tint);
    canvasUtils.applyPatternTransform(pattern, fill.transform);
    return pattern;
  }
  const texture = style.texture;
  if (texture && texture !== Texture.WHITE) {
    if (!texture.source.resource) {
      return emptyCanvasStyle;
    }
    const pattern = canvasUtils.getTintedPattern(texture, tint);
    const patternMatrix = textureMatrix ? tempPatternMatrix.copyFrom(textureMatrix).scale(texture.source.pixelWidth, texture.source.pixelHeight) : style.matrix;
    canvasUtils.applyPatternTransform(pattern, patternMatrix);
    return pattern;
  }
  return colorToHex(tint);
}
class CanvasGraphicsAdaptor {
  constructor() {
    this.shader = null;
  }
  contextChange(renderer) {
  }
  execute(graphicsPipe, renderable) {
    const renderer = graphicsPipe.renderer;
    const contextSystem = renderer.canvasContext;
    const context = contextSystem.activeContext;
    const baseTransform = renderable.groupTransform;
    const globalColor = renderer.globalUniforms.globalUniformData?.worldColor ?? 4294967295;
    const groupColorAlpha = renderable.groupColorAlpha;
    const globalAlpha = (globalColor >>> 24 & 255) / 255;
    const groupAlphaValue = (groupColorAlpha >>> 24 & 255) / 255;
    const filterAlpha = renderer.filter?.alphaMultiplier ?? 1;
    const groupAlpha = globalAlpha * groupAlphaValue * filterAlpha;
    if (groupAlpha <= 0) return;
    const globalTint = globalColor & 16777215;
    const groupTintBGR = groupColorAlpha & 16777215;
    const groupTint = bgr2rgb(multiplyHexColors(groupTintBGR, globalTint));
    const roundPixels = renderer._roundPixels | renderable._roundPixels;
    context.save();
    contextSystem.setContextTransform(baseTransform, roundPixels === 1);
    contextSystem.setBlendMode(renderable.groupBlendMode);
    const instructions = renderable.context.instructions;
    for (let i = 0; i < instructions.length; i++) {
      const instruction = instructions[i];
      if (instruction.action === "texture") {
        const data2 = instruction.data;
        const texture = data2.image;
        const source = texture ? canvasUtils.getCanvasSource(texture) : null;
        if (!source) continue;
        const alpha2 = data2.alpha * groupAlpha;
        if (alpha2 <= 0) continue;
        const tint2 = multiplyHexColors(data2.style, groupTint);
        context.globalAlpha = alpha2;
        let drawSource = source;
        if (tint2 !== 16777215) {
          drawSource = canvasUtils.getTintedCanvas({ texture }, tint2);
        }
        const frame = texture.frame;
        const resolution = texture.source._resolution ?? texture.source.resolution ?? 1;
        let sx = frame.x * resolution;
        let sy = frame.y * resolution;
        const sw = frame.width * resolution;
        const sh = frame.height * resolution;
        if (drawSource !== source) {
          sx = 0;
          sy = 0;
        }
        const transform = data2.transform;
        const hasTransform = transform && !transform.isIdentity();
        const rotate = texture.rotate;
        if (hasTransform || rotate) {
          tempMatrix.copyFrom(baseTransform);
          if (hasTransform) {
            tempMatrix.append(transform);
          }
          if (rotate) {
            groupD8.matrixAppendRotationInv(tempMatrix, rotate, data2.dx, data2.dy, data2.dw, data2.dh);
          }
          contextSystem.setContextTransform(tempMatrix, roundPixels === 1);
        } else {
          contextSystem.setContextTransform(baseTransform, roundPixels === 1);
        }
        context.drawImage(
          drawSource,
          sx,
          sy,
          drawSource === source ? sw : drawSource.width,
          drawSource === source ? sh : drawSource.height,
          rotate ? 0 : data2.dx,
          rotate ? 0 : data2.dy,
          data2.dw,
          data2.dh
        );
        if (hasTransform || rotate) {
          contextSystem.setContextTransform(baseTransform, roundPixels === 1);
        }
        continue;
      }
      const data = instruction.data;
      const shapePath = data?.path?.shapePath;
      if (!shapePath?.shapePrimitives?.length) continue;
      const style = data.style;
      const tint = multiplyHexColors(style.color, groupTint);
      const alpha = style.alpha * groupAlpha;
      if (alpha <= 0) continue;
      const isStroke = instruction.action === "stroke";
      context.globalAlpha = alpha;
      if (isStroke) {
        const strokeStyle = style;
        context.lineWidth = strokeStyle.width;
        context.lineCap = strokeStyle.cap;
        context.lineJoin = strokeStyle.join;
        context.miterLimit = strokeStyle.miterLimit;
      }
      const shapePrimitives = shapePath.shapePrimitives;
      if (!isStroke && data.hole?.shapePath?.shapePrimitives?.length) {
        const lastShape = shapePrimitives[shapePrimitives.length - 1];
        lastShape.holes = data.hole.shapePath.shapePrimitives;
      }
      for (let j = 0; j < shapePrimitives.length; j++) {
        const primitive = shapePrimitives[j];
        if (!primitive?.shape) continue;
        const transform = primitive.transform;
        const hasTransform = transform && !transform.isIdentity();
        const hasTexture = style.texture && style.texture !== Texture.WHITE;
        const textureTransform = style.textureSpace === "global" ? transform : null;
        const textureMatrix = hasTexture ? generateTextureMatrix(tempTextureMatrix, style, primitive.shape, textureTransform) : null;
        const currentTransform = hasTransform ? tempGradientMatrix.copyFrom(baseTransform).append(transform) : baseTransform;
        const canvasStyle = getCanvasStyle(
          style,
          tint,
          textureMatrix,
          currentTransform
        );
        if (hasTransform) {
          context.save();
          context.transform(transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty);
        }
        if (isStroke) {
          const strokeStyle = style;
          const useStrokeGeometry = strokeStyle.alignment !== 0.5 && !strokeStyle.pixelLine;
          if (useStrokeGeometry) {
            const points = [];
            const vertices = [];
            const indices = [];
            const shapeBuilder = shapeBuilders[primitive.shape.type];
            if (shapeBuilder?.build(primitive.shape, points)) {
              const close = primitive.shape.closePath ?? true;
              buildLine(points, strokeStyle, false, close, vertices, indices);
              context.fillStyle = canvasStyle;
              fillTriangles(context, vertices, indices);
            } else {
              context.strokeStyle = canvasStyle;
              context.beginPath();
              buildShapePath(context, primitive.shape);
              context.stroke();
            }
          } else {
            context.strokeStyle = canvasStyle;
            context.beginPath();
            buildShapePath(context, primitive.shape);
            context.stroke();
          }
        } else {
          context.fillStyle = canvasStyle;
          context.beginPath();
          buildShapePath(context, primitive.shape);
          const hasHoles = addHolePaths(context, primitive.holes);
          if (hasHoles) {
            context.fill("evenodd");
          } else {
            context.fill();
          }
        }
        if (hasTransform) {
          context.restore();
        }
      }
    }
    context.restore();
  }
  destroy() {
    this.shader = null;
  }
}
CanvasGraphicsAdaptor.extension = {
  type: [
    ExtensionType.CanvasPipesAdaptor
  ],
  name: "graphics"
};
class CanvasRenderTargetAdaptor {
  /**
   * Initializes the adaptor.
   * @param renderer - Canvas renderer instance.
   * @param renderTargetSystem - The render target system.
   * @advanced
   */
  init(renderer, renderTargetSystem) {
    this._renderer = renderer;
    this._renderTargetSystem = renderTargetSystem;
  }
  /**
   * Creates a GPU render target for canvas.
   * @param renderTarget - Render target to initialize.
   * @advanced
   */
  initGpuRenderTarget(renderTarget) {
    const colorTexture = renderTarget.colorTexture;
    const { canvas, context } = this._ensureCanvas(colorTexture);
    return {
      canvas,
      context,
      width: canvas.width,
      height: canvas.height
    };
  }
  /**
   * Resizes the backing canvas for a render target.
   * @param renderTarget - Render target to resize.
   * @advanced
   */
  resizeGpuRenderTarget(renderTarget) {
    const colorTexture = renderTarget.colorTexture;
    const { canvas } = this._ensureCanvas(colorTexture);
    canvas.width = renderTarget.pixelWidth;
    canvas.height = renderTarget.pixelHeight;
  }
  /**
   * Starts a render pass on the canvas target.
   * @param renderTarget - Target to render to.
   * @param clear - Clear mode.
   * @param clearColor - Optional clear color.
   * @param viewport - Optional viewport.
   * @advanced
   */
  startRenderPass(renderTarget, clear, clearColor, viewport) {
    const gpuRenderTarget = this._renderTargetSystem.getGpuRenderTarget(renderTarget);
    this._renderer.canvasContext.activeContext = gpuRenderTarget.context;
    this._renderer.canvasContext.activeResolution = renderTarget.resolution;
    if (clear) {
      this.clear(renderTarget, clear, clearColor, viewport);
    }
  }
  /**
   * Clears the render target.
   * @param renderTarget - Target to clear.
   * @param _clear - Clear mode (unused).
   * @param clearColor - Optional clear color.
   * @param viewport - Optional viewport rectangle.
   * @advanced
   */
  clear(renderTarget, _clear, clearColor, viewport) {
    const gpuRenderTarget = this._renderTargetSystem.getGpuRenderTarget(renderTarget);
    const context = gpuRenderTarget.context;
    const bounds = viewport || { x: 0, y: 0, width: renderTarget.pixelWidth, height: renderTarget.pixelHeight };
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(bounds.x, bounds.y, bounds.width, bounds.height);
    if (clearColor) {
      const color = Color.shared.setValue(clearColor);
      if (color.alpha > 0) {
        context.globalAlpha = color.alpha;
        context.fillStyle = color.toHex();
        context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
        context.globalAlpha = 1;
      }
    }
  }
  /**
   * Finishes the render pass (no-op for canvas).
   * @advanced
   */
  finishRenderPass() {
  }
  /**
   * Copies a render target into a texture source.
   * @param {RenderTarget} sourceRenderSurfaceTexture - Source render target.
   * @param {Texture} destinationTexture - Destination texture.
   * @param {object} originSrc - Source origin.
   * @param {number} originSrc.x - Source x origin.
   * @param {number} originSrc.y - Source y origin.
   * @param {object} size - Copy size.
   * @param {number} size.width - Copy width.
   * @param {number} size.height - Copy height.
   * @param {object} [originDest] - Destination origin.
   * @param {number} originDest.x - Destination x origin.
   * @param {number} originDest.y - Destination y origin.
   * @advanced
   */
  copyToTexture(sourceRenderSurfaceTexture, destinationTexture, originSrc, size, originDest) {
    const sourceGpuTarget = this._renderTargetSystem.getGpuRenderTarget(sourceRenderSurfaceTexture);
    const sourceCanvas = sourceGpuTarget.canvas;
    const destSource = destinationTexture.source;
    const { context } = this._ensureCanvas(destSource);
    const dx = originDest?.x ?? 0;
    const dy = originDest?.y ?? 0;
    context.drawImage(
      sourceCanvas,
      originSrc.x,
      originSrc.y,
      size.width,
      size.height,
      dx,
      dy,
      size.width,
      size.height
    );
    destSource.update();
    return destinationTexture;
  }
  /**
   * Destroys a GPU render target (no-op for canvas).
   * @param _gpuRenderTarget - Target to destroy.
   * @advanced
   */
  destroyGpuRenderTarget(_gpuRenderTarget) {
  }
  _ensureCanvas(source) {
    let canvas = source.resource;
    if (!canvas || !CanvasSource.test(canvas)) {
      canvas = DOMAdapter.get().createCanvas(source.pixelWidth, source.pixelHeight);
      source.resource = canvas;
    }
    if (canvas.width !== source.pixelWidth || canvas.height !== source.pixelHeight) {
      canvas.width = source.pixelWidth;
      canvas.height = source.pixelHeight;
    }
    const context = canvas.getContext("2d");
    return { canvas, context };
  }
}
class CanvasRenderTargetSystem extends RenderTargetSystem {
  constructor(renderer) {
    super(renderer);
    this.adaptor = new CanvasRenderTargetAdaptor();
    this.adaptor.init(renderer, this);
  }
}
CanvasRenderTargetSystem.extension = {
  type: [ExtensionType.CanvasSystem],
  name: "renderTarget"
};
class CanvasTextureSystem {
  /**
   * @param renderer - The owning CanvasRenderer.
   */
  constructor(renderer) {
  }
  /** Initializes the system (no-op for canvas). */
  init() {
  }
  /**
   * Initializes a texture source (no-op for canvas).
   * @param _source - Texture source.
   */
  initSource(_source) {
  }
  /**
   * Creates a canvas containing the texture's frame.
   * @param texture - Texture to render.
   */
  generateCanvas(texture) {
    const canvas = DOMAdapter.get().createCanvas();
    const context = canvas.getContext("2d");
    const source = canvasUtils.getCanvasSource(texture);
    if (!source) {
      return canvas;
    }
    const frame = texture.frame;
    const resolution = texture.source._resolution ?? texture.source.resolution ?? 1;
    const sx = frame.x * resolution;
    const sy = frame.y * resolution;
    const sw = frame.width * resolution;
    const sh = frame.height * resolution;
    canvas.width = Math.ceil(sw);
    canvas.height = Math.ceil(sh);
    context.drawImage(
      source,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      sw,
      sh
    );
    return canvas;
  }
  /**
   * Reads pixel data from a texture.
   * @param texture - Texture to read.
   */
  getPixels(texture) {
    const canvas = this.generateCanvas(texture);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    return {
      pixels: imageData.data,
      width: canvas.width,
      height: canvas.height
    };
  }
  /** Destroys the system (no-op for canvas). */
  destroy() {
  }
}
CanvasTextureSystem.extension = {
  type: [
    ExtensionType.CanvasSystem
  ],
  name: "texture"
};
const DefaultCanvasSystems = [
  ...SharedSystems,
  CanvasContextSystem,
  CanvasLimitsSystem,
  CanvasTextureSystem,
  CanvasRenderTargetSystem
];
const DefaultCanvasPipes = [
  BlendModePipe,
  BatcherPipe,
  SpritePipe,
  RenderGroupPipe,
  AlphaMaskPipe,
  CanvasStencilMaskPipe,
  CanvasColorMaskPipe,
  CustomRenderPipe
];
const DefaultCanvasAdapters = [
  CanvasBatchAdaptor,
  CanvasGraphicsAdaptor
];
const systems = [];
const renderPipes = [];
const renderPipeAdaptors = [];
extensions.handleByNamedList(ExtensionType.CanvasSystem, systems);
extensions.handleByNamedList(ExtensionType.CanvasPipes, renderPipes);
extensions.handleByNamedList(ExtensionType.CanvasPipesAdaptor, renderPipeAdaptors);
extensions.add(...DefaultCanvasSystems, ...DefaultCanvasPipes, ...DefaultCanvasAdapters);
class CanvasRenderer extends AbstractRenderer {
  constructor() {
    const systemConfig = {
      name: "canvas",
      type: RendererType.CANVAS,
      systems,
      renderPipes,
      renderPipeAdaptors
    };
    super(systemConfig);
  }
}
export {
  CanvasRenderer
};
