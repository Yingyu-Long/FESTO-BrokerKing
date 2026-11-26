import { useEffect, useRef } from "react";
import Icon from "../components/Icon";
import { translations, type Language } from "../../translate";

type ConsumptionResetDialogProps = {
  consumption: number;
  canControl: boolean;
  resetConsumption: () => Promise<void>;
  onClose: () => void;
  notify: (message: string) => void;
  language: Language;
};

export default function ConsumptionResetDialog({
  consumption,
  canControl,
  resetConsumption,
  onClose,
  notify,
  language,
}: ConsumptionResetDialogProps) {
  const copy = translations[language].dashboard;
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  async function handleReset() {
    try {
      await resetConsumption();
      onClose();
      notify(copy.resetDone);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Tab") {
            e.preventDefault();
            const buttons = e.currentTarget.querySelectorAll("button");
            (document.activeElement === buttons[0] ? buttons[1] : buttons[0]).focus();
          }
        }}
      >
        <div className="modal-icon">
          <Icon name="reset" size={26} />
        </div>
        <h2 id="reset-title">{copy.resetTitle}</h2>
        <p>
          {copy.resetMessage} <strong>{consumption.toFixed(3)} m³</strong>
          {copy.resetMessageEnd}
        </p>
        <div className="modal-actions">
          <button ref={cancelRef} className="button" onClick={onClose}>
            {copy.cancel}
          </button>
          <button className="button primary" disabled={!canControl} onClick={handleReset}>
            {copy.confirmReset}
          </button>
        </div>
      </section>
    </div>
  );
}
