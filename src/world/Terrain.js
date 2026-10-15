import * as THREE from 'three';
import { getTerrainDetail } from './TerrainDetail.js';
import { createNoise } from '../utils/noise.js';

/**
 * Procedural height-field terrain built directly as a BufferGeometry.
 *
 * A regular grid of (segments+1)^2 vertices is laid out on the XZ plane.
 * Each vertex height y = heightFn(x, z), where heightFn is a route-specific
 * function built from noise (fBm / ridged noise). Each vertex also gets a
 * colour from colorFn(height, slope), e.g. snow on peaks or rock on steep
 * slopes, so no image textures are needed (vertex colours).
 *
 * SURFACE DETAIL: vertex colours alone look smooth and plasticky up close, so
 * two tileable procedural textures are layered on top (see TerrainDetail.js):
 *   uv  (1 repeat / 30 m) -> colour detail map, multiplies the vertex colour
 *   uv1 (1 repeat / 9 m)  -> bump map, per-pixel normal perturbation
 * Using two different scales hides the repetition of each texture.
 * Large-scale colour variation (patches) is added with low-frequency noise.
 *
 * Triangles: each grid cell is split into two triangles. We keep the exact
 * same split in heightAt(), so collision height matches the rendered
 * surface exactly (barycentric interpolation inside the triangle).
 */
export class Terrain {
  /**
   * @param {object} o
   * @param {number} o.size        world size in metres (square, centred on cx, cz)
   * @param {number} o.segments    grid cells per side
   * @param {(x:number,z:number)=>number} o.heightFn
   * @param {(h:number,slope:number,x:number,z:number,out:THREE.Color)=>void} o.colorFn
   * @param {boolean} [o.flatShading=false] faceted low-poly look instead of smooth shading
   * @param {number} [o.colorVariation=0.14] strength of large-scale colour patches
   * @param {number} [o.bumpScale=1.2]
   */
  constructor({
    size, segments, heightFn, colorFn, cx = 0, cz = 0,
    flatShading = false, roughness = 0.95, colorVariation = 0.14, bumpScale = 1.2,
  }) {
    this.size = size;
    this.segments = segments;
    this.cell = size / segments;
    this.x0 = cx - size / 2;
    this.z0 = cz - size / 2;

    const n = segments + 1;
    this.heights = new Float32Array(n * n);

    const positions = new Float32Array(n * n * 3);
    const colors = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);
    const uvs1 = new Float32Array(n * n * 2);
    const { fbm } = createNoise(17);

    // 1) Sample the height function on the grid
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const x = this.x0 + ix * this.cell;
        const z = this.z0 + iz * this.cell;
        const h = heightFn(x, z);
        const i = iz * n + ix;
        this.heights[i] = h;
        positions.set([x, h, z], i * 3);
      }
    }

    // 2) Colour each vertex from height + slope (slope via finite differences)
    const col = new THREE.Color();
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        const hL = this.heights[iz * n + Math.max(ix - 1, 0)];
        const hR = this.heights[iz * n + Math.min(ix + 1, segments)];
        const hD = this.heights[Math.max(iz - 1, 0) * n + ix];
        const hU = this.heights[Math.min(iz + 1, segments) * n + ix];
        const slope = Math.hypot(hR - hL, hU - hD) / (2 * this.cell); // rise over run
        const x = positions[i * 3], z = positions[i * 3 + 2];
        colorFn(this.heights[i], slope, x, z, col);
        // Large-scale patches: brighten/darken by low-frequency noise
        col.multiplyScalar(1 + colorVariation * fbm(x / 90, z / 90, 3));
        colors.set([col.r, col.g, col.b], i * 3);
        // World-space texture coordinates at two scales
        uvs.set([x / 30, z / 30], i * 2);
        uvs1.set([x / 9, z / 9], i * 2);
      }
    }

    // 3) Index buffer: two triangles per cell, counter-clockwise seen from above
    const indices = new Uint32Array(segments * segments * 6);
    let k = 0;
    for (let iz = 0; iz < segments; iz++) {
      for (let ix = 0; ix < segments; ix++) {
        const a = iz * n + ix; //       a ---- d      (ix, iz)   (ix+1, iz)
        const b = (iz + 1) * n + ix; // |  \   |
        const c = (iz + 1) * n + ix + 1; // b ---- c  (ix, iz+1) (ix+1, iz+1)
        const d = iz * n + ix + 1;
        indices[k++] = a; indices[k++] = b; indices[k++] = d; // triangle (a, b, d)
        indices[k++] = b; indices[k++] = c; indices[k++] = d; // triangle (b, c, d)
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('uv1', new THREE.BufferAttribute(uvs1, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const detail = getTerrainDetail();
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness,
      metalness: 0,
      flatShading,
      map: detail.colorDetail,
      bumpMap: detail.bump,
      bumpScale,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'Terrain';
    this.mesh.receiveShadow = true;
  }

  /** Exact surface height at world (x, z), matching the rendered triangles. */
  heightAt(x, z) {
    const n = this.segments + 1;
    let fx = (x - this.x0) / this.cell;
    let fz = (z - this.z0) / this.cell;
    if (fx < 0 || fz < 0 || fx >= this.segments || fz >= this.segments) return -Infinity;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    fx -= ix;
    fz -= iz;
    const h = this.heights;
    const h00 = h[iz * n + ix];
    const h10 = h[iz * n + ix + 1];
    const h01 = h[(iz + 1) * n + ix];
    const h11 = h[(iz + 1) * n + ix + 1];
    // Same diagonal as the index buffer (from b=(0,1) to d=(1,0))
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
