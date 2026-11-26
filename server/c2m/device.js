import { setTimeout as delay } from "node:timers/promises";
import { ModbusClient } from "./modbus.js";
import { connectionConfig } from "./config.js";

export class DeviceError extends Error {
  constructor(message, code = "VALIDATION", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
// MSE6-C2M Am.0 control word. Preserve unrelated bits on every update.
const CONTROL = {
  shutoff: 1 << 0,
  autoMode: 1 << 1,
  resetTimer: 1 << 2,
  userPressureSelect: 3 << 3,
  autoEnable: 1 << 5,
  consumptionRun: 1 << 12,
  resetConsumption: 1 << 13,
};
const PULSE_MASK = CONTROL.resetTimer | CONTROL.resetConsumption;
const PRESSURE_CONTROL_MASK =
  CONTROL.shutoff | CONTROL.autoMode | CONTROL.userPressureSelect | CONTROL.autoEnable;
// Application-owned standby latch: USER variable pressure, supply open.
// AUTO enable has no effect in USER, so it can identify this held state.
const STANDBY_CONTROL = CONTROL.userPressureSelect | CONTROL.autoEnable;
const CONSUMPTION_32_SELECTION = 10000;
// Module parameter byte offsets; both reads and writes use this mapping.
const PARAMETER_OFFSETS = { delay: 17, threshold: 19, normal: 21, standby: 23 };
const phaseByCode = {
  0: "RISE",
  1: "NORMAL",
  2: "NORMAL",
  3: "NORMAL",
  4: "NORMAL",
  5: "SHUTOFF",
  8: "NORMAL",
  9: "WAIT",
  10: "HOLD",
  11: "SHUTOFF",
  12: "STANDBY",
  13: "RISE",
};
export const pressureScale = (unit) => ({ mbar: 0.001, kPa: 0.01, "psi/10": 0.006894757293 })[unit];
export const volumeScale = (unit) => ({ l: 0.001, m3: 1, scf: 0.028316846592 })[unit];
const flowScale = (unit) => (unit === "l/min" ? 1 : 2.8316846592);
const parameterScale = (key, config) =>
  ["normal", "standby", "userPressure"].includes(key)
    ? pressureScale(config.pressureUnit)
    : key === "threshold"
      ? flowScale(config.flowUnit)
      : 1;
const isRecoverableError = (error) => error instanceof DeviceError && error.status < 500;
const swap = (word) => ((word & 255) << 8) | (word >>> 8);

export class DeviceService {
  constructor(config, client = new ModbusClient({ timeout: config.timeout })) {
    this.config = config;
    this.client = client;
    this.queue = Promise.resolve();
    this.queued = 0;
    this.state = {
      status: "disconnected",
      connection: null,
      telemetry: null,
      controls: null,
      parameters: null,
      lastError: null,
      identity: null,
      deviceInfo: null,
      sequence: 0,
      warnings: [],
    };
    this.price = 0.12;
    this.leakLimit = 0.1;
    this.manualPressureRaw = null;
  }
  snapshot() {
    const fresh =
      this.state.status === "connected" &&
      this.state.telemetry &&
      Date.now() - this.state.telemetry.timestamp <
        Math.max(3000, (this.state.connection?.poll ?? 1000) * 3);
    const canWrite = !!(
      fresh &&
      this.config.mappingConfirmed &&
      phaseByCode[this.state.telemetry.stateCode] &&
      this.config.writesEnabled &&
      this.state.controls &&
      !this.state.controls.resetPending
    );
    return {
      ...this.state,
      fresh: !!fresh,
      canWrite,
      canConfigure: canWrite && this.config.diagnosticInput !== null,
      mappingReady: this.config.mappingConfirmed,
      readingEnabled: this.readingEnabled(),
      localSettings: { price: this.price, leakLimit: this.leakLimit },
    };
  }
  readingEnabled() {
    return this.config.inputBase !== null && this.config.mappingConfirmed;
  }
  exclusive(work) {
    if (this.queued >= 8)
      return Promise.reject(new DeviceError("Device queue is busy", "BUSY", 409));
    this.queued++;
    const next = this.queue.then(work).finally(() => {
      this.queued--;
    });
    this.queue = next.catch(() => {});
    return next;
  }
  stopPolling() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  schedule() {
    this.stopPolling();
    if (this.state.status !== "connected" || !this.readingEnabled()) return;
    const snapshot = this.snapshot();
    const { telemetry, controls, parameters } = this.state;
    const deadline =
      snapshot.canWrite &&
      controls.mode === "auto" &&
      !controls.standbyHeld &&
      telemetry.timerState === 1 &&
      telemetry.timerStartedAt != null &&
      parameters
        ? telemetry.timerStartedAt + parameters.delay * 60_000
        : null;
    // Wake at the displayed deadline even when the normal poll interval is long.
    const nextPoll =
      deadline === null
        ? this.state.connection.poll
        : Math.min(this.state.connection.poll, Math.max(1, deadline - Date.now()));
    this.timer = setTimeout(() => {
      this.exclusive(async () => {
        if (this.state.status !== "connected") return;
        try {
          await this.poll();
        } catch (error) {
          this.fault(error);
        }
      }).finally(() => this.schedule());
    }, nextPoll);
    this.timer.unref?.();
  }
  fault(error) {
    this.stopPolling();
    this.client.close();
    this.state.status = "error";
    this.state.parameters = null;
    this.state.lastError = {
      code: error.code || "DEVICE_ERROR",
      message: error.message,
    };
  }
  connect(body) {
    const connection = connectionConfig(body);
    return this.exclusive(async () => {
      this.stopPolling();
      this.client.close();
      const old = this.state.connection;
      if (!old || ["host", "port", "unit"].some((key) => old[key] !== connection[key]))
        this.manualPressureRaw = null;
      this.state = {
        ...this.state,
        status: "connecting",
        connection,
        telemetry: null,
        controls: null,
        parameters: null,
        lastError: null,
        warnings: [],
        identity: null,
        deviceInfo: null,
      };
      try {
        await this.client.connect(connection);
        const info = await this.client.readDeviceIdentification();
        this.state.deviceInfo = info;
        this.state.identity = info.productCode;
        if (!/^CPX-(M-)?FB36$/i.test(info.productCode.trim()))
          throw new DeviceError(
            `Expected CPX-FB36, received ${info.productCode}`,
            "DEVICE_MISMATCH",
            409,
          );
        this.state.status = "connected";
        if (this.readingEnabled()) {
          await this.poll();
          // The dashboard countdown needs the actual delay, including on reconnect.
          if (this.config.diagnosticInput !== null && this.config.outputEchoBase !== null) {
            await this.readParameters();
            await this.poll();
          }
        } else this.state.warnings = ["MAPPING_REQUIRED"];
        this.schedule();
        return this.snapshot();
      } catch (error) {
        this.fault(error);
        throw error;
      }
    });
  }
  disconnect() {
    return this.exclusive(async () => {
      this.stopPolling();
      this.client.close();
      this.state.status = "disconnected";
      this.state.lastError = null;
      this.state.warnings = [];
      return this.snapshot();
    });
  }
  decodeWords(words) {
    return this.config.swapProcessBytes ? words.map(swap) : words;
  }
  async readOutputs() {
    if (!this.config.mappingConfirmed || this.config.outputEchoBase === null) return null;
    return this.decodeWords(await this.client.read(this.config.outputEchoBase, 3));
  }
  isStandbyHeld(outputs, standby = this.state.parameters?.standby) {
    return (
      !!outputs &&
      Number.isFinite(standby) &&
      (outputs[0] & PRESSURE_CONTROL_MASK) === STANDBY_CONTROL &&
      outputs[2] === Math.round(standby / pressureScale(this.config.pressureUnit))
    );
  }
  async poll({ supervise = true } = {}) {
    const words = this.decodeWords(await this.client.read(this.config.inputBase, 7));
    const outputs = await this.readOutputs();
    const statusWord = words[3],
      stateCode = (statusWord >>> 8) & 15;
    if (words[0] > 32767 || words[2] > 32767)
      throw new DeviceError(
        "Invalid process values; verify mapping and byte order",
        "INVALID_MAPPING",
        502,
      );
    const timestamp = Date.now();
    const previous = this.state.telemetry;
    const timerState = (statusWord >>> 4) & 3;
    // The module exposes RES/RUN/UP, not elapsed seconds. When joining RUN,
    // count from the first observation and label the result as an upper bound.
    const continuous =
      previous &&
      timestamp - previous.timestamp < Math.max(3000, (this.state.connection?.poll ?? 1000) * 3);
    const continuingTimer = timerState === 1 && previous?.timerState === 1;
    const timerStartedAt =
      timerState === 1
        ? continuingTimer
          ? (previous.timerStartedAt ?? timestamp)
          : timestamp
        : null;
    const timerStartEstimated =
      timerState === 1 &&
      (continuingTimer
        ? !continuous || (previous.timerStartEstimated ?? true)
        : !continuous || previous.timerState !== 0);
    const pressure = words[2] * pressureScale(this.config.pressureUnit);
    const delta = previous
      ? (pressure - previous.pressure) / ((timestamp - previous.timestamp) / 1000 || 1)
      : null;
    const is32 = words[4] === CONSUMPTION_32_SELECTION;
    const rawVolume = is32 ? words[6] * 65536 + words[5] : words[1];
    const warnings = [];
    if (!is32 && rawVolume === 65535) warnings.push("CONSUMPTION_SATURATED");
    if (!(statusWord & 0x1000)) warnings.push("CONSUMPTION_STOPPED");
    if (stateCode === 7) warnings.push("LOAD_VOLTAGE_MISSING");
    if (!phaseByCode[stateCode]) warnings.push("UNKNOWN_MODULE_STATE");
    this.state.telemetry = {
      timestamp,
      flow: words[0] * flowScale(this.config.flowUnit),
      pressure,
      consumption: rawVolume * volumeScale(this.config.consumptionUnit),
      delta,
      phase: phaseByCode[stateCode] || "UNKNOWN",
      stateCode,
      timerState,
      timerStartedAt,
      timerStartEstimated,
      valveOpen: !(statusWord & 1),
      consumptionRunning: !!(statusWord & 0x1000),
      consumptionBits: is32 ? 32 : 16,
      tick: ++this.state.sequence,
    };
    // Commands are reflected by the output echo, valve state by Em.3.0.
    const standbyHeld = this.isStandbyHeld(outputs);
    this.state.controls = outputs
      ? {
          mode: standbyHeld || outputs[0] & CONTROL.autoMode ? "auto" : "user",
          standbyHeld,
          enabled: !!(outputs[0] & CONTROL.autoEnable),
          manualOpen: !(outputs[0] & CONTROL.shutoff),
          resetPending: !!(outputs[0] & PULSE_MASK),
          userPressure:
            (standbyHeld ? (this.manualPressureRaw ?? outputs[2]) : outputs[2]) *
            pressureScale(this.config.pressureUnit),
        }
      : null;
    if (this.state.controls?.resetPending) warnings.push("RESET_PENDING");
    this.state.warnings = warnings;
    this.state.lastError = null;
    const parameters = this.state.parameters;
    // Check the previous deadline too: a native reset at the very next sample
    // must not undo a countdown that has already reached zero in the dashboard.
    const expired =
      parameters &&
      [timerStartedAt, previous?.timerStartedAt].some(
        (start) => start != null && timestamp >= start + parameters.delay * 60_000,
      );
    if (
      supervise &&
      this.snapshot().canWrite &&
      parameters &&
      outputs[0] & CONTROL.autoMode &&
      (timerState === 2 || expired)
    ) {
      await this.holdStandbyPressure();
      await this.poll({ supervise: false });
    }
  }
  async holdStandbyPressure() {
    this.assertWrite();
    const standby = this.state.parameters?.standby;
    if (!Number.isFinite(standby) || standby < 2.5 || standby > 10)
      throw new DeviceError("Read valid standby pressure before starting the timer");
    const outputs = await this.readOutputs();
    if (!(outputs[0] & CONTROL.autoMode)) return;
    this.manualPressureRaw = outputs[2];
    // Am.0.3-4=3 selects Am.2; there is no direct normal/standby selector.
    await this.writeOutputs(2, [Math.round(standby / pressureScale(this.config.pressureUnit))]);
    await this.maskedControl(PRESSURE_CONTROL_MASK, STANDBY_CONTROL);
  }
  async restoreManualPressure() {
    if (this.manualPressureRaw !== null) await this.writeOutputs(2, [this.manualPressureRaw]);
  }
  async restartAutomaticTimer() {
    const normal = this.state.parameters?.normal;
    if (!Number.isFinite(normal) || normal < 2.5 || normal > 10)
      throw new DeviceError("Read device parameters before restarting the timer");
    const outputs = await this.readOutputs();
    const wasHeld = this.isStandbyHeld(outputs);
    if (!wasHeld) {
      this.manualPressureRaw = outputs[2];
      // USER must not briefly apply an unrelated manual setpoint during reset.
      await this.writeOutputs(2, [Math.round(normal / pressureScale(this.config.pressureUnit))]);
    }
    // USER with AUTO enable cleared resets Q_low regardless of the configured
    // Am.0.2/DI reset source. Wait for input feedback before re-entering AUTO.
    try {
      await this.maskedControl(PRESSURE_CONTROL_MASK, CONTROL.userPressureSelect);
      await this.waitForState(
        (telemetry) => [0, 4].includes(telemetry.stateCode) && telemetry.timerState === 0,
        "Device did not confirm timer reset; automatic restart was not applied",
      );
      await this.maskedControl(
        PRESSURE_CONTROL_MASK,
        CONTROL.autoMode | CONTROL.userPressureSelect,
      );
      // Output echo can precede module processing. Restore the manual draft
      // only after the module is using its normal AUTO pressure parameter.
      // Keep automatic standby disabled during this confirmation, so even a
      // zero-minute delay cannot hide the return to working pressure.
      await this.waitForState(
        (telemetry) => [8, 9, 10, 13].includes(telemetry.stateCode) && telemetry.valveOpen,
        "Device did not confirm return to automatic working pressure",
      );
      await this.restoreManualPressure();
      await this.maskedControl(CONTROL.autoEnable, CONTROL.autoEnable);
    } catch (error) {
      if (wasHeld && error.code === "TIMER_RESET_TIMEOUT") {
        await this.maskedControl(PRESSURE_CONTROL_MASK, STANDBY_CONTROL);
      }
      throw error;
    }
  }
  async waitForState(accept, message) {
    const deadline = performance.now() + this.config.timeout;
    do {
      await this.poll({ supervise: false });
      if (accept(this.state.telemetry)) return;
      if (performance.now() >= deadline) break;
      await delay(30);
    } while (performance.now() < deadline);
    throw new DeviceError(message, "TIMER_RESET_TIMEOUT", 502);
  }
  assertWrite(allowReset = false) {
    const s = this.snapshot();
    if (!s.fresh || !phaseByCode[this.state.telemetry.stateCode])
      throw new DeviceError("Device data is unavailable or stale", "NOT_CONNECTED", 409);
    if (!this.config.mappingConfirmed || !this.config.writesEnabled || !this.state.controls)
      throw new DeviceError(
        "Writes require a confirmed output/echo mapping and writesEnabled",
        "WRITES_DISABLED",
        409,
      );
    if (this.state.controls.resetPending && !allowReset)
      throw new DeviceError(
        "Reset bit is still asserted; release reset before continuing",
        "RESET_PENDING",
        409,
      );
  }
  async writeOutputs(offset, words) {
    await this.client.write(
      this.config.outputBase + offset,
      this.config.swapProcessBytes ? words.map(swap) : words,
    );
    const end = Date.now() + this.config.timeout;
    do {
      const echo = await this.readOutputs();
      if (words.every((v, i) => echo[offset + i] === v)) return;
      await delay(30);
    } while (Date.now() < end);
    throw new DeviceError(
      "Output feedback did not confirm command; check other controllers",
      "FEEDBACK_MISMATCH",
      502,
    );
  }
  async maskedControl(mask, value) {
    const [word] = await this.readOutputs();
    if (word & PULSE_MASK && mask !== PULSE_MASK)
      throw new DeviceError("Reset remains asserted", "RESET_PENDING", 409);
    const next = (word & ~mask) | (value & mask);
    await this.writeOutputs(0, [next]);
  }
  control(body) {
    return this.exclusive(async () => {
      const { action, value } = body || {};
      const allowed = [
        "mode",
        "valve",
        "consumption-run",
        "reset-timer",
        "reset-consumption",
        "release-reset",
        "consumption-32",
      ];
      if (!allowed.includes(action)) throw new DeviceError("Unknown control action");
      if (action === "mode" && !["auto", "user"].includes(value))
        throw new DeviceError("Invalid mode");
      if (["valve", "consumption-run"].includes(action) && typeof value !== "boolean")
        throw new DeviceError("Expected boolean value");
      this.assertWrite(action === "release-reset");
      try {
        if (action === "mode") {
          // Selecting the already-active automatic mode must not release a hold.
          if (value === "user") {
            if (this.state.controls.standbyHeld) await this.restoreManualPressure();
            await this.maskedControl(
              CONTROL.autoMode | CONTROL.autoEnable | CONTROL.userPressureSelect,
              CONTROL.userPressureSelect,
            );
          } else if (!this.state.controls.standbyHeld) {
            await this.maskedControl(
              CONTROL.autoMode | CONTROL.autoEnable,
              CONTROL.autoMode | CONTROL.autoEnable,
            );
          }
        }
        if (action === "valve") {
          const outputs = await this.readOutputs();
          if (outputs[0] & CONTROL.autoMode || this.isStandbyHeld(outputs))
            throw new DeviceError("Manual valve control requires user mode", "AUTO_MODE", 409);
          await this.maskedControl(CONTROL.shutoff, value ? 0 : CONTROL.shutoff);
        }
        if (action === "consumption-run")
          await this.maskedControl(CONTROL.consumptionRun, value ? CONTROL.consumptionRun : 0);
        if (action === "release-reset") await this.maskedControl(PULSE_MASK, 0);
        if (action === "consumption-32") {
          await this.writeOutputs(1, [CONSUMPTION_32_SELECTION]);
          const end = Date.now() + this.config.timeout;
          do {
            const data = this.decodeWords(await this.client.read(this.config.inputBase + 4, 1));
            if (data[0] === CONSUMPTION_32_SELECTION) break;
            if (Date.now() >= end)
              throw new DeviceError(
                "Optional input selection not confirmed",
                "FEEDBACK_MISMATCH",
                502,
              );
            await delay(30);
          } while (Date.now() <= end);
        }
        if (action === "reset-timer" && this.state.controls.mode === "auto") {
          await this.restartAutomaticTimer();
        } else if (action === "reset-timer" || action === "reset-consumption") {
          const bit = action === "reset-timer" ? CONTROL.resetTimer : CONTROL.resetConsumption;
          const [word] = await this.readOutputs();
          try {
            await this.writeOutputs(0, [word | bit]);
            await delay(this.config.pulseMs);
            // Observe RES while the pulse is held so the next RUN gets a new start.
            if (action === "reset-timer") await this.poll({ supervise: false });
          } finally {
            await this.writeOutputs(0, [word & ~bit]);
          }
        }
        await this.poll();
        this.schedule();
        return this.snapshot();
      } catch (error) {
        if (!isRecoverableError(error)) this.fault(error);
        throw error;
      }
    });
  }
  assertDiagnostic() {
    this.assertWrite();
    if (this.config.diagnosticInput === null)
      throw new DeviceError(
        "I/O diagnostic mapping is required for parameters",
        "DIAGNOSTICS_REQUIRED",
        409,
      );
  }
  // FB36 table 140: bit15 rising edge, bit14 byte/word, bit13 read/write.
  async systemByte(offset, value, word = false) {
    const functionNumber = 4828 + this.config.moduleNumber * 64 + offset;
    const command = functionNumber | (value === undefined ? 0 : 0x2000) | (word ? 0x4000 : 0);
    const out = this.config.diagnosticOutput,
      input = this.config.diagnosticInput;
    await this.client.write(out, [command, value ?? 0]);
    const clearDeadline = Date.now() + this.config.timeout;
    while ((await this.client.read(input, 1))[0] !== 0) {
      if (Date.now() > clearDeadline)
        throw new DeviceError("Diagnostic interface did not clear", "DIAGNOSTIC_TIMEOUT", 502);
      await delay(20);
    }
    await this.client.write(out, [command | 0x8000, value ?? 0]);
    try {
      const deadline = Date.now() + this.config.timeout;
      do {
        const [result, data] = await this.client.read(input, 2);
        if (result === 0x8000) return word ? data : data & 255;
        if (result > 0x8000)
          throw new DeviceError(
            `CPX diagnostic error 0x${result.toString(16)}`,
            "DIAGNOSTIC_ERROR",
            502,
          );
        await delay(20);
      } while (Date.now() < deadline);
      throw new DeviceError("Diagnostic request timed out", "DIAGNOSTIC_TIMEOUT", 502);
    } finally {
      await this.client.write(out, [command, value ?? 0]);
    }
  }
  async checkUnits() {
    const units = await this.systemByte(8);
    const actual = {
      pressureUnit: ["mbar", "kPa", "psi/10"][units & 3],
      flowUnit: ["l/min", null, "scfm/10"][(units >>> 2) & 3],
      consumptionUnit: ["l", "m3", "scf"][(units >>> 4) & 3],
    };
    for (const key of Object.keys(actual))
      if (actual[key] !== this.config[key])
        throw new DeviceError(`Device ${key} differs from configured units`, "UNIT_MISMATCH", 409);
  }
  async readWord(offset) {
    return this.systemByte(offset, undefined, true);
  }
  async readParameters() {
    await this.checkUnits();
    const result = {};
    for (const [key, offset] of Object.entries(PARAMETER_OFFSETS)) {
      const raw = await this.readWord(offset);
      result[key] = raw * parameterScale(key, this.config);
    }
    const outputs = await this.readOutputs();
    if (!this.isStandbyHeld(outputs, result.standby)) this.manualPressureRaw = outputs[2];
    result.userPressure =
      (this.manualPressureRaw ?? outputs[2]) * pressureScale(this.config.pressureUnit);
    this.state.parameters = {
      ...result,
      price: this.price,
      leakLimit: this.leakLimit,
    };
    return this.state.parameters;
  }
  refreshParameters() {
    return this.exclusive(async () => {
      this.assertDiagnostic();
      try {
        await this.readParameters();
        await this.poll();
        this.schedule();
        return this.snapshot();
      } catch (error) {
        this.state.parameters = null;
        if (error.code === "UNIT_MISMATCH" || !isRecoverableError(error)) this.fault(error);
        throw error;
      }
    });
  }
  applyParameters(body) {
    return this.exclusive(async () => {
      this.assertDiagnostic();
      const fields = {
        threshold: [0, 32767],
        delay: [0, 65535],
        normal: [2.5, 10],
        standby: [2.5, 10],
        userPressure: [2.5, 10],
        price: [0, 100],
        leakLimit: [0.01, 10],
      };
      for (const [key, [min, max]] of Object.entries(fields))
        if (
          typeof body?.[key] !== "number" ||
          !Number.isFinite(body[key]) ||
          body[key] < min ||
          body[key] > max
        )
          throw new DeviceError(`Invalid parameter: ${key}`);
      if (!Number.isInteger(body.delay) || body.normal <= body.standby)
        throw new DeviceError("Invalid delay/threshold or pressure order");
      try {
        // Apply a parameter set only in manual mode; the entire set is not atomic.
        const outputs = await this.readOutputs();
        if (outputs[0] & CONTROL.autoMode || this.isStandbyHeld(outputs))
          throw new DeviceError(
            "Switch to manual mode before applying device parameters",
            "AUTO_MODE",
            409,
          );
        const old = await this.readParameters();
        const toRaw = (key, value) => Math.round(value / parameterScale(key, this.config));
        if (toRaw("normal", body.normal) <= toRaw("standby", body.standby))
          throw new DeviceError("Pressure values round to an invalid order");
        const pressureKeys =
          body.normal <= old.standby ? ["standby", "normal"] : ["normal", "standby"];
        for (const key of ["threshold", "delay", ...pressureKeys]) {
          const offset = PARAMETER_OFFSETS[key];
          const raw = toRaw(key, body[key]);
          if (raw !== toRaw(key, old[key])) {
            await this.systemByte(offset, raw, true);
            if ((await this.readWord(offset)) !== raw)
              throw new DeviceError(
                `Parameter readback mismatch: ${key}`,
                "PARAMETER_MISMATCH",
                502,
              );
          }
        }
        const userRaw = toRaw("userPressure", body.userPressure);
        await this.writeOutputs(2, [userRaw]);
        this.manualPressureRaw = userRaw;
        await this.maskedControl(CONTROL.userPressureSelect, CONTROL.userPressureSelect);
        this.price = body.price;
        this.leakLimit = body.leakLimit;
        await this.readParameters();
        await this.poll();
        return this.snapshot();
      } catch (error) {
        this.state.parameters = null;
        if (error.code === "UNIT_MISMATCH" || !isRecoverableError(error)) {
          error.message += "; some parameters may already have changed. Read back before retrying.";
          this.fault(error);
        }
        throw error;
      }
    });
  }
}
