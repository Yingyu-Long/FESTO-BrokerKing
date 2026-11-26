import type { DeviceController } from "../dashboard/useDevice";
import { useState, type FormEvent } from "react";
import type { Parameters } from "../types";
import { fields } from "./fields";
import Icon from "../components/Icon";
import Panel from "../components/Panel";
import { translations, type Language } from "../../translate";
import {
  isParameterDraft,
  parameterDraftKey,
  parametersToDraft,
  readStored,
  removeStored,
  writeStored,
} from "../persistence";
import type { ParameterDraft } from "../persistence";

const configFields = fields.filter((field) => field.key !== "userPressure");

function ConsumptionSwitch({
  device,
  notify,
  language,
  mode,
}: {
  device: DeviceController;
  notify: (message: string) => void;
  language: Language;
  mode: "measurement" | "bits";
}) {
  const zh = language === "zh";
  const telemetry = device.backend?.telemetry;
  const connected = device.backend?.status === "connected";
  const consumptionRunning = telemetry?.consumptionRunning ?? false;
  const is32Bit = (telemetry?.consumptionBits ?? 16) === 32;

  async function run(operation: () => Promise<unknown>) {
    try {
      await operation();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  }

  const isMeasurement = mode === "measurement";
  const enabled = isMeasurement ? consumptionRunning : is32Bit;
  const label = isMeasurement
    ? zh
      ? "耗气量累计"
      : "Consumption measurement"
    : zh
      ? "32位耗气量"
      : "32-bit consumption";
  const description = isMeasurement
    ? consumptionRunning
      ? zh
        ? "正在累计"
        : "Running"
      : zh
        ? "已停止"
        : "Stopped"
    : is32Bit
      ? zh
        ? "已启用，精度更高"
        : "Enabled, higher precision"
      : zh
        ? "当前16位，范围有限"
        : "Currently 16-bit, limited range";

  return (
    <div className="consumption-switch-row">
      <div className="switch-label">
        <strong>{label}</strong>
        <small>{description}</small>
      </div>
      <button
        type="button"
        className={`switch ${enabled ? "on" : ""}`}
        role="switch"
        aria-label={label}
        aria-checked={enabled}
        disabled={!device.canControl || !connected || (!isMeasurement && is32Bit)}
        onClick={() => {
          if (isMeasurement && !consumptionRunning) void run(device.startConsumption);
          if (!isMeasurement && !is32Bit) void run(device.select32Bit);
        }}
      >
        <span />
      </button>
    </div>
  );
}

type ConfigProps = {
  device: DeviceController;
  notify: (message: string) => void;
  language: Language;
};

export default function Config({ notify, language, device }: ConfigProps) {
  const { params, applyParameters } = device;
  const draftKey = parameterDraftKey(device.settingsScope);
  const [savedDraft, setSavedDraft] = useState(() => readStored(draftKey, isParameterDraft));
  const draft = savedDraft ?? parametersToDraft(params);
  function setDraft(next: ParameterDraft) {
    writeStored(draftKey, next);
    setSavedDraft(next);
  }
  function clearDraft() {
    removeStored(draftKey);
    setSavedDraft(null);
  }
  const [error, setError] = useState("");
  const copy = translations[language].config;
  if (!device.settingsReady)
    return (
      <Panel title={copy.title}>
        <p>{language === "zh" ? "正在加载配置…" : "Loading settings…"}</p>
      </Panel>
    );
  async function saveParameters(e: FormEvent) {
    e.preventDefault();
    const next: Parameters = {
      ...params,
      ...Object.fromEntries(configFields.map((field) => [field.key, Number(draft[field.key])])),
    };
    if (
      configFields.some(
        (f) =>
          draft[f.key].trim() === "" ||
          !Number.isFinite(next[f.key]) ||
          next[f.key] < f.min ||
          next[f.key] > f.max,
      )
    ) {
      setError(copy.required);
      return;
    }
    if (next.normal <= next.standby) {
      setError(copy.pressureOrder);
      return;
    }
    try {
      await applyParameters(next);
      clearDraft();
      setError("");
      notify(copy.applied);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  const dirty = configFields.some(
    (f) => Number(draft[f.key]) !== params[f.key] || draft[f.key] === "",
  );
  return (
    <>
      <Panel
        title={copy.title}
        extra={
          <button
            className="text-button"
            disabled={device.busy || !device.backend?.canConfigure}
            onClick={async () => {
              try {
                const result = await device.refreshParameters();
                if (result.parameters) clearDraft();
                setError("");
              } catch (error) {
                setError(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            {language === "zh" ? "读取设备参数" : "Read from device"}
          </button>
        }
      >
        <p className="device-notice">
          {language === "zh"
            ? "先读取设备参数，切换手动模式后再应用修改。"
            : "Read device parameters first. Switch to manual mode before applying changes."}
        </p>
        <form onSubmit={saveParameters}>
          <div className="form-grid">
            {configFields.map((f) => (
              <div className="config-field-group" key={f.key}>
                <label className="field">
                  <span>{language === "en" ? f.titleEn : f.title}</span>
                  <div className="input-unit">
                    <input
                      type="number"
                      disabled={device.busy}
                      required
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      value={draft[f.key]}
                      onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    />
                    <span>{f.unit}</span>
                  </div>
                  <small>
                    {copy.range} {f.min} – {f.max} {f.unit}
                  </small>
                </label>
                {f.key === "price" && (
                  <ConsumptionSwitch
                    device={device}
                    notify={notify}
                    language={language}
                    mode="measurement"
                  />
                )}
                {f.key === "leakLimit" && (
                  <ConsumptionSwitch
                    device={device}
                    notify={notify}
                    language={language}
                    mode="bits"
                  />
                )}
              </div>
            ))}
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <span>{dirty ? copy.unsaved : ""}</span>
            <button
              type="button"
              className="button"
              disabled={device.busy}
              onClick={() => {
                clearDraft();
                setError("");
              }}
            >
              {copy.undo}
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={
                !dirty ||
                device.busy ||
                !device.backend?.canConfigure ||
                !device.backend.parameters ||
                device.mode === "auto"
              }
            >
              <Icon name="check" size={17} />
              {copy.apply}
            </button>
          </div>
        </form>
      </Panel>
    </>
  );
}
