import { useState, type FormEvent } from "react";
import { fields } from "../config/fields";
import Icon from "../components/Icon";
import { translations, type Language } from "../../translate";
import type { DeviceController } from "./useDevice";

const pressureField = fields.find((field) => field.key === "userPressure")!;

export default function ManualPressureSetting({
  device,
  notify,
  language,
}: {
  device: DeviceController;
  notify: (message: string) => void;
  language: Language;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const copy = translations[language].config;
  const parameters = device.backend?.parameters;
  const currentPressure = parameters?.userPressure ?? device.backend?.controls?.userPressure;
  const value = draft ?? (currentPressure == null ? "" : String(currentPressure));
  const canApply = !device.busy && !!device.backend?.canConfigure && device.mode === "user";
  const dirty = draft !== null;

  async function savePressure(event: FormEvent) {
    event.preventDefault();
    if (!canApply) return;
    const pressure = Number(value);
    if (
      value.trim() === "" ||
      !Number.isFinite(pressure) ||
      pressure < pressureField.min ||
      pressure > pressureField.max
    ) {
      setError(copy.required);
      return;
    }
    try {
      const latestParameters = parameters ?? (await device.refreshParameters()).parameters;
      if (!latestParameters) {
        throw new Error(
          language === "zh"
            ? "未能读取设备参数，请重试。"
            : "Could not read device parameters. Please try again.",
        );
      }
      await device.applyParameters({ ...latestParameters, userPressure: pressure });
      setDraft(null);
      setError("");
      notify(copy.applied);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <form className="manual-pressure" onSubmit={savePressure}>
      <div className="manual-pressure-controls">
        <label className="field">
          <span>{language === "en" ? pressureField.titleEn : pressureField.title}</span>
          <div className="input-unit">
            <input
              type="number"
              required
              disabled={device.busy}
              min={pressureField.min}
              max={pressureField.max}
              step={pressureField.step}
              value={value}
              placeholder="—"
              onChange={(event) => {
                setDraft(event.target.value);
                setError("");
              }}
            />
            <span>{pressureField.unit}</span>
          </div>
        </label>
        <button className="button primary" type="submit" disabled={!canApply || !dirty}>
          <Icon name="check" size={17} />
          {copy.apply}
        </button>
      </div>
      <small>
        {copy.range} {pressureField.min} – {pressureField.max} {pressureField.unit}
      </small>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
