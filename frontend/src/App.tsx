import { useState } from "react";
import "./App.css";
import Onboarding from "./pages/Onboarding";
import Fund from "./pages/Fund";
import Transfer from "./pages/Transfer";

const TABS = [
  "Onboarding",
  "Deposit",
  "Transfer",
  "Redeem",
  "Compliance",
  "Reconciliation",
] as const;

type Tab = (typeof TABS)[number];

const PLACEHOLDER_PHASE: Record<Tab, string> = {
  Onboarding: "Phase 3",
  Deposit: "Phase 4",
  Transfer: "Phase 5",
  Redeem: "Phase 8",
  Compliance: "Phase 6 / 6.5",
  Reconciliation: "Phase 9",
};

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("Onboarding");

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Tokenized Deposit Settlement</h1>
        <p className="app-subtitle">Proof-of-concept — localhost validator</p>
      </header>

      <nav className="tab-nav">
        {TABS.map((tab) => (
          <button
            key={tab}
            className={tab === activeTab ? "tab-button active" : "tab-button"}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>

      <main className="tab-content">
        {activeTab === "Onboarding" ? (
          <Onboarding />
        ) : activeTab === "Deposit" ? (
          <Fund />
        ) : activeTab === "Transfer" ? (
          <Transfer />
        ) : (
          <>
            <h2>{activeTab}</h2>
            <p>Coming in {PLACEHOLDER_PHASE[activeTab]} of the implementation plan.</p>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
