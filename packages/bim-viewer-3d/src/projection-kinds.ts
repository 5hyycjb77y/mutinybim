/** The two 3D projections, without the camera maths (no three.js), for the light entry. */
export const PROJECTIONS = ["perspective", "orthographic"] as const;
export type Projection = (typeof PROJECTIONS)[number];
