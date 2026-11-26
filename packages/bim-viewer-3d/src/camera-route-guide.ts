import * as THREE from "three";
import type { Point3 } from "@permitzip/bim-kernel";
import { kernelToScene } from "./coords";

/** Keep the followed centreline legible as it passes behind the building envelope. */
export function cameraRouteGuide(scene: THREE.Scene, path: readonly Point3[], color: string) {
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(path.map(p => new THREE.Vector3(...kernelToScene(p.x, p.y, p.z)))),
    new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true }),
  );
  const marker = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]),
    new THREE.PointsMaterial({ color, size: 8, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }),
  );
  line.renderOrder = 20;
  marker.renderOrder = 21;
  scene.add(line, marker);
  return {
    move(p: Point3) { marker.position.set(...kernelToScene(p.x, p.y, p.z)); },
    dispose() {
      scene.remove(line, marker);
      line.geometry.dispose();
      line.material.dispose();
      marker.geometry.dispose();
      marker.material.dispose();
    },
  };
}
