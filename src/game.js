// The run's numbers: a port of the game's GSystem code (USA 1ST_READ.BIN, the
// struct at 0x0C1EC4A8; EU 0x0C1EE788 in the decomp's docs/engine.md). Pure JS so
// node tests can check it.
//
// Ported routines (USA addresses):
//   init_GameSystem 0x0C02D16E  the start time: TIME_OPTIONS[option byte 1] * 60
//                               (3/5/10 minute modes: 10800/18000/36000 frames)
//   game tick       0x0C02CC96  customer time, trip meter, game time, the "pick
//                               someone up" nag timer, time up
//   GS_GuestIn      0x0C02CE32  the customer's time and the fare from the route length
//   GS_GuestResult  0x0C02CFC4  rating 0/1/2 from the customer time left
//   GS_GuestOut     0x0C02CFE8  pays: +120/+300 frames, time money = time left x 10
//   GS_GuestEject   (decomp game_e.c) the customer gave up: combo and level back one
//   GS_TripMetor    (decomp game_o.c) trip meter += distance / 10
//   payment         0x0C053FFA  cash += fare + time money + tips, capped at 9,999,999
// Money is in cents (the HUD rolls "$ 1,234.56"). Times are 60 Hz frames.

// Option bytes (0x0C2881F0, defaults copied from 0x0C09C5C0: [0, 4, 3, 3, 8, 8, 0, 1, ...]).
export const TIME_OPTIONS = [70, 65, 60, 55, 50, 45, 40, 35];              // 0x0C0896C0, seconds
export const CUSTOMER_TIME_OPTIONS = [210, 180, 90, 0, -90, -180, -270, -360]; // 0x0C08A658, frames
export const DEFAULT_TIME_OPTION = 4;        // 50 s
export const DEFAULT_CUSTOMER_OPTION = 3;    // +0

// Per level (level = +0x3C, raised every 1200 trip-meter units, lowered by an eject).
export const LEVEL_EXTRA = [1800, 1620, 1380, 1380, 1200, 1200, 1020, 1020, 900, 840, 840];   // 0x0C08A598
export const LEVEL_FAST = [300, 300, 300, 300, 300, 300, 300, 300, 300, 300, 300];            // 0x0C08A5C8
export const LEVEL_SPEEDY = [1500, 1200, 900, 900, 840, 780, 660, 660, 600, 540, 540];        // 0x0C08A5F8
// Per elapsed minute of the run.
export const MINUTE_SCALE = [1, 1, 1, 0.98, 0.95, 0.95, 0.93, 0.93, 0.9, 0.9, 0.86];           // 0x0C08A628

export const TIME_PER_UNIT = 0.11;      // frames per route unit
export const TIME_BASE = 240;           // frames
export const TIME_MIN = 300;            // frames
export const FARE_PER_UNIT = 2.5;       // cents per route unit (0x0C02D03C)
export const TIME_MONEY_PER_FRAME = 10; // cents per frame of customer time left
export const RATING_BONUS = [0, 120, 300]; // frames: normal, fast, speedy
export const RATING_NAMES = ['NORMAL', 'FAST', 'SPEEDY'];
export const CASH_CAP = 9999999;
export const TRIP_LEVEL_STEP = 1200;
export const START_COUNTDOWN = 366;     // frames (0x16E); the car is released at 60
export const TIME_UP_HOLD = 150;        // frames before the results
export const NAG_FIRST = 900;           // "pick someone up" after 15 s without a fare
export const NAG_AGAIN = 600;

export const STATE_COUNTDOWN = 0;
export const STATE_RUNNING = 1;
export const STATE_TIME_UP = 2;

const fint = (x) => Math.trunc(x);
const f32 = Math.fround;

export class GameSystem {
  constructor({ timeOption = DEFAULT_TIME_OPTION, customerOption = DEFAULT_CUSTOMER_OPTION, timeMode = 0 } = {}) {
    this.timeOption = timeOption;
    this.customerOption = customerOption;
    this.timeMode = timeMode;    // GetMenuMode(1): 0 arcade rules, 1/2/3 = 3/5/10 minutes
    this.reset();
  }

  reset() {
    this.state = STATE_COUNTDOWN;   // 0x0C1EC50C
    this.countdown = START_COUNTDOWN; // 0x0C1EC510
    this.started = 0;               // +0x00 (1 once the countdown lets the car go, 3 at time up)
    this.aboard = false;            // +0x04
    this.frames = 0;                // +0x08
    this.time = [0, 10800, 18000, 36000][this.timeMode] || TIME_OPTIONS[this.timeOption] * 60; // +0x0C
    this.pending = 0;               // +0x10 time waiting to flow into the clock
    this.customers = 0;             // +0x14 delivered
    this.route = 0;                 // +0x1C the current fare's route length
    this.cash = 0;                  // +0x20
    this.timeMoney = 0;             // +0x28
    this.fare = 0;                  // +0x2C
    this.tips = 0;                  // +0x30
    this.tripA = 0;                 // +0x34
    this.tripB = 0;                 // +0x38
    this.level = 0;                 // +0x3C
    this.levelRaised = 1;           // +0x40 (init writes 1)
    this.customerTime = 0;          // +0x44
    this.levelExtra = LEVEL_EXTRA[0]; // +0x48
    this.fastLimit = LEVEL_FAST[0]; // +0x4C
    this.speedyLimit = 0;           // +0x50
    this.combo = 1;                 // +0x54
    this.chain = 0;                 // +0x58
    this.pickedUp = 0;              // +0x5C
    this.nagLimit = NAG_FIRST;      // +0x60
    this.nagTimer = 0;              // 0x0C1EC514
    this.customerTimeTotal = 0;     // for the HUD bar (not in the struct)
    this.paid = null;               // last payment, for the HUD
    this.nags = 0;
    this.controlOn = false;         // Car_Data + 0x54
  }

  /** One frame of exec_GameSystem (the handler for the current state). */
  tick() {
    if (this.state === STATE_COUNTDOWN) {
      this.countdown--;
      if (this.countdown === 60) { this.controlOn = true; this.started = 1; }
      if (this.countdown <= 0) this.state = STATE_RUNNING;
      return;
    }
    if (this.state === STATE_TIME_UP) {
      this.controlOn = false;
      this.countdown--;
      return;
    }
    // 0x0C02CC96: the running game.
    if (this.aboard && this.customerTime > 0) this.customerTime--;
    if (this.tripB > TRIP_LEVEL_STEP) {
      this.tripB -= TRIP_LEVEL_STEP;
      this.level++;
      this.levelRaised = 1;
    }
    this.frames++;
    if (this.started === 1 && this.time > 0) this.time--;
    if (this.time === 0) {
      this.state = STATE_TIME_UP;
      this.countdown = TIME_UP_HOLD;
      this.started = 3;
      this.controlOn = false;
      return;
    }
    if (this.pickedUp <= 1 && !this.aboard) {
      if (this.nagTimer >= this.nagLimit) {
        this.nags++;
        this.nagLimit = NAG_AGAIN;
        this.nagTimer = 0;
      }
      this.nagTimer++;
    }
    // Put_Remain_Time_Add: at most 60 frames of the pending bonus per frame.
    if (this.pending > 0) {
      const d = Math.min(60, this.pending);
      this.time += d;
      this.pending -= d;
    }
  }

  get timeUpDone() { return this.state === STATE_TIME_UP && this.countdown < 0; }

  /** GS_TripMetor(x): called with the distance the cab moved this frame. */
  tripMeter(x) {
    const d = f32(x * f32(0.099999994));
    this.tripA = f32(this.tripA + d);
    this.tripB = f32(this.tripB + d);
  }

  /** GS_GuestIn: a customer with this route length got in. */
  guestIn(routeLength) {
    this.aboard = true;
    this.route = routeLength;
    const offset = CUSTOMER_TIME_OPTIONS[this.customerOption];
    let t = f32(f32(routeLength * f32(TIME_PER_UNIT)) + f32(offset + TIME_BASE));
    const minute = Math.min(10, fint(this.frames / 3600));
    t = f32(t * f32(MINUTE_SCALE[minute]));
    if (t < TIME_MIN) t = TIME_MIN;
    const lv = Math.min(10, this.level);
    this.levelExtra = LEVEL_EXTRA[lv];
    this.fastLimit = LEVEL_FAST[lv];
    this.speedyLimit = LEVEL_SPEEDY[lv];
    if (this.levelExtra > this.time + this.pending) this.levelExtra = this.time + this.pending;
    this.customerTime = fint(t) + this.levelExtra;
    this.customerTimeTotal = this.customerTime;
    this.pending = fint(this.pending + t);
    if (this.timeMode !== 0) this.pending = 0;
    this.fare += fint(f32(this.route * f32(FARE_PER_UNIT)));
    this.pickedUp++;
  }

  /** GS_GuestResult: 0 normal, 1 fast, 2 speedy. */
  guestResult() {
    if (this.customerTime <= this.fastLimit) return 0;
    if (this.customerTime >= this.speedyLimit) return 2;
    return 1;
  }

  /** GS_GuestOut: the customer arrived. Returns the rating and pays. */
  guestOut() {
    const rating = this.guestResult();
    if (this.timeMode === 0) this.pending += RATING_BONUS[rating];
    this.aboard = false;
    this.customers++;
    this.combo = 1;
    this.chain++;
    this.timeMoney = this.customerTime * TIME_MONEY_PER_FRAME;
    this.customerTime = 0;
    this.nagLimit = NAG_FIRST;
    this.pay(rating);
    return rating;
  }

  /** 0x0C053FFA: the fare roll adds everything into the cash. */
  pay(rating) {
    const total = this.fare + this.timeMoney + this.tips;
    this.cash = Math.min(CASH_CAP, this.cash + total);
    this.paid = { rating, fare: this.fare, timeMoney: this.timeMoney, tips: this.tips, total, bonus: this.timeMode === 0 ? RATING_BONUS[rating] : 0 };
    this.fare = this.timeMoney = this.tips = 0;
  }

  /** GS_GuestEject: the customer's time ran out. */
  guestEject() {
    this.customerTime = 0;
    this.aboard = false;
    if (this.combo && this.chain > 0) { this.chain--; this.combo = 0; }
    if (this.levelRaised && this.level > 0) { this.level--; this.levelRaised = 0; }
    this.fare = this.timeMoney = this.tips = 0;
    this.paid = null;
  }

  /** Seconds for the HUD clock. */
  seconds() { return Math.ceil(this.time / 60); }
}

/** "$ 1,234.56" from cents. */
export function formatMoney(cents) {
  const dollars = Math.floor(cents / 100);
  const c = cents % 100;
  return `$${dollars.toLocaleString('en-US')}.${String(c).padStart(2, '0')}`;
}
