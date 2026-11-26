import { useEffect, useState } from "react";
import type { Parameters, Phase } from "../types";
import type { DeviceController } from "./useDevice";
import Icon from "../components/Icon";
import Panel from "../components/Panel";
import ManualPressureSetting from "./ManualPressureSetting";
import { remainingLowFlowSeconds } from "./lowFlowTimer";
import { translations, type Language } from "../../translate";

type OperationControlProps = {
  params: Parameters;
  device: DeviceController;
  phase: Phase;
  notify: (message: string) => void;
  language: Language;
};

export default function OperationControl({
  params,
  device,
  phase,
  notify,
  language,
}: OperationControlProps) {
  const { mode, manualOpen, setManualOpen, valveOpen, changeMode, resetTimer } = device;
  const copy = translations[language].dashboard;
  const telemetry = device.backend?.telemetry;
  const standbyHeld = device.backend?.controls?.standbyHeld ?? false;
  const timerState = telemetry?.timerState;
  const sampleTimestamp = telemetry?.timestamp;
  const [clock, setClock] = useState({ sampleTimestamp: 0, timestamp: 0 });
  useEffect(() => {
    if (!device.dataReady || timerState !== 1 || sampleTimestamp === undefined) return;
    const receivedAt = performance.now();
    const timer = setInterval(
      () =>
        setClock({
          sampleTimestamp,
          timestamp: sampleTimestamp + performance.now() - receivedAt,
        }),
      250,
    );
    return () => clearInterval(timer);
  }, [device.dataReady, timerState, sampleTimestamp]);
  const timestamp = clock.sampleTimestamp === sampleTimestamp ? clock.timestamp : sampleTimestamp;
  const remainingDelay =
    telemetry && device.backend?.parameters
      ? remainingLowFlowSeconds(
          params.delay,
          telemetry.timerStartedAt,
          timestamp ?? telemetry.timestamp,
        )
      : null;
  const standbyStatus = !device.backend?.parameters
    ? copy.timerParametersRequired
    : !device.backend.canWrite
      ? copy.timerStandbyUnavailable
      : copy.timerSwitchingStandby;

  const statusLabel = !device.dataReady
    ? "—"
    : standbyHeld
      ? `0:00 · ${copy.timerStandbyHeld}`
      : timerState === 2
        ? `0:00 · ${standbyStatus}`
        : timerState === 1
          ? remainingDelay === null
            ? copy.timerParametersRequired
            : remainingDelay > 0
              ? `${telemetry?.timerStartEstimated ? copy.timerRemainingMaximum : copy.timerRemaining} ${Math.floor(remainingDelay / 60)}:${String(remainingDelay % 60).padStart(2, "0")}`
              : `0:00 · ${standbyStatus}`
          : timerState === 0
            ? copy.timerIdle
            : "—";

  return (
    <Panel title={copy.operationControl}>
      <div className="control-body">
        <div className="label-row">
          <span>{copy.controlMode}</span>
        </div>
        <div className="mode-switch" role="group" aria-label={copy.controlMode}>
          <button
            className={mode === "auto" ? "selected" : ""}
            disabled={!device.canControl}
            onClick={() => changeMode("auto")}
          >
            <Icon name="settings" />
            {copy.autoMode}
          </button>
          <button
            className={mode === "user" ? "selected" : ""}
            disabled={!device.canControl}
            onClick={() => changeMode("user")}
          >
            <Icon name="plug" />
            {copy.manualMode}
          </button>
        </div>
        {mode === "auto" ? (
          <>
            <div className="timer">
              <div className="label-row" role="timer" aria-live="off">
                <span>{copy.lowFlowTimer}</span>
                <strong>{statusLabel}</strong>
              </div>
              <div className="timer-foot">
                <span>
                  {device.dataReady
                    ? standbyHeld
                      ? copy.standbyHeldPhase
                      : copy.phase[phase]
                    : "—"}
                </span>
                <button className="text-button" disabled={!device.canControl} onClick={resetTimer}>
                  <Icon name="reset" size={14} />
                  {copy.resetTimer}
                </button>
              </div>
              {device.dataReady && standbyHeld && (
                <p className="timer-notice">{copy.standbyHeldNotice}</p>
              )}
              {device.dataReady &&
                !standbyHeld &&
                timerState === 1 &&
                remainingDelay !== null &&
                remainingDelay > 0 &&
                telemetry?.timerStartEstimated && (
                  <p className="timer-notice">{copy.timerEstimateNotice}</p>
                )}
            </div>
          </>
        ) : (
          <>
            <div className="setting-row">
              <div>
                <strong>{copy.shutoffValve}</strong>
              </div>
              <div className="segmented">
                <button
                  className={manualOpen ? "selected" : ""}
                  disabled={!device.canControl}
                  onClick={() => setManualOpen(true)}
                >
                  {copy.open}
                </button>
                <button
                  className={!manualOpen ? "selected" : ""}
                  disabled={!device.canControl}
                  onClick={() => setManualOpen(false)}
                >
                  {copy.closed}
                </button>
              </div>
            </div>
            <ManualPressureSetting
              key={device.settingsScope}
              device={device}
              notify={notify}
              language={language}
            />
          </>
        )}
        <div className="control-status">
          <span className={`dot ${valveOpen ? "" : "muted"}`} />
          <strong>
            {copy.shutoffValve} {device.dataReady ? (valveOpen ? copy.open : copy.closed) : "—"}
          </strong>
        </div>
      </div>
    </Panel>
  );
}
