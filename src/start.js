// Where the cab starts, from init_CarMain (decomp src/gen_bz.c): in the normal
// game (game_init sets the byte at 0x0C1EE35C to 1) the Arcade city puts the car
// at the last point of course 0 (the main line) moved 135 along +z, heading
// 0x5000 (112.5 deg); reversed, at point 2 moved -140 along z, heading 0xD000.
// The Original city uses fixed values: (288.46, 2304.12, 4535.49) heading 0x349F,
// reversed (-1087.71, 102.08, -6556.46) heading 0xC69. y gains 0.2 for cabs 0-3
// (0.1 for the hidden fourth cab).
//
// Headings are the game's 16-bit angles: forward = (sin h, 0, cos h).

const TURN = Math.PI * 2 / 65536;
const CAB_LIFT = 0.2;

// Arcade course 0's last point (local-assets/courses/arcade.json, course 0, point 385).
const ARCADE_LINE_LAST = [-196.698, 1505.0, 1700.0];
const ARCADE_LINE_P2 = [566.666, 1505.0, 1699.91];

export const START = {
  arcade: {
    x: ARCADE_LINE_LAST[0], y: ARCADE_LINE_LAST[1] + CAB_LIFT, z: ARCADE_LINE_LAST[2] + 135,
    heading: 0x5000 * TURN,
  },
  arcade_reverse: {
    x: ARCADE_LINE_P2[0], y: ARCADE_LINE_P2[1] + CAB_LIFT, z: ARCADE_LINE_P2[2] - 140,
    heading: 0xD000 * TURN,
  },
  original: { x: 288.459991, y: 2304.11987 + CAB_LIFT, z: 4535.48975, heading: 0x349F * TURN },
  original_reverse: { x: -1087.70996, y: 102.079994 + CAB_LIFT, z: -6556.45996, heading: 0xC69 * TURN },
};

export const CITIES = {
  arcade: { models: 'models/BINC1.glb', props: 'props/OBJDC1.glb', collision: 'collision/arcade.json', start: START.arcade },
  original: { models: 'models/BINC2.glb', props: 'props/OBJDC2.glb', collision: 'collision/original.json', start: START.original },
  // The Crazy Box's course (its games' start spots come from init_CarMain / Init_DCmini).
  crazybox: { models: 'models/BINC3.glb', props: 'props/OBJDC3.glb' },
};
