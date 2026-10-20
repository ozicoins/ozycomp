import { H as Shader, J as State, u as GpuProgram, p as GlProgram } from "./OfficeFloor-BwoXLG0T.js";
const _Filter = class _Filter2 extends Shader {
  /**
   * @param options - The optional parameters of this filter.
   */
  constructor(options) {
    options = { ..._Filter2.defaultOptions, ...options };
    super(options);
    this.enabled = true;
    this._state = State.for2d();
    this.blendMode = options.blendMode;
    this.padding = options.padding;
    if (typeof options.antialias === "boolean") {
      this.antialias = options.antialias ? "on" : "off";
    } else {
      this.antialias = options.antialias;
    }
    this.resolution = options.resolution;
    this.blendRequired = options.blendRequired;
    this.clipToViewport = options.clipToViewport;
    this.addResource("uTexture", 0, 1);
    if (options.blendRequired) {
      this.addResource("uBackTexture", 0, 3);
    }
  }
  /**
   * Applies the filter
   * @param filterManager - The renderer to retrieve the filter from
   * @param input - The input render target.
   * @param output - The target to output to.
   * @param clearMode - Should the output be cleared before rendering to it
   */
  apply(filterManager, input, output, clearMode) {
    filterManager.applyFilter(this, input, output, clearMode);
  }
  /**
   * Get the blend mode of the filter.
   * @default "normal"
   */
  get blendMode() {
    return this._state.blendMode;
  }
  /** Sets the blend mode of the filter. */
  set blendMode(value) {
    this._state.blendMode = value;
  }
  /**
   * A short hand function to create a filter based of a vertex and fragment shader src.
   * @param options
   * @returns A shiny new PixiJS filter!
   */
  static from(options) {
    const { gpu, gl, ...rest } = options;
    let gpuProgram;
    let glProgram;
    if (gpu) {
      gpuProgram = GpuProgram.from(gpu);
    }
    if (gl) {
      glProgram = GlProgram.from(gl);
    }
    return new _Filter2({
      gpuProgram,
      glProgram,
      ...rest
    });
  }
};
_Filter.defaultOptions = {
  blendMode: "normal",
  resolution: 1,
  padding: 0,
  antialias: "off",
  blendRequired: false,
  clipToViewport: true
};
let Filter = _Filter;
export {
  Filter as F
};
