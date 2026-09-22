import { useState } from 'react';
import type { PropertyDto } from '@suiviinvest/api-contract';
import { request } from '../../lib/api.ts';
import { useAction } from '../../lib/useAction.ts';
import { Card } from '../ui/Card.tsx';
import { ActionFeedback } from '../ui/ActionFeedback.tsx';

export interface PropertyFormsProps {
  readonly properties: readonly PropertyDto[];
  readonly onChanged: () => void;
}

/** Catégories proposées, alignées sur le schéma serveur (`cashFlowSchema`). */
const INCOME_CATEGORIES: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'RENT', label: 'Loyer' },
  { value: 'RENT_CHARGES', label: 'Provisions pour charges' },
  { value: 'OTHER_INCOME', label: 'Autre revenu' },
];

const EXPENSE_CATEGORIES: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'CONDO_FEES', label: 'Charges de copropriété' },
  { value: 'PROPERTY_TAX', label: 'Taxe foncière' },
  { value: 'PNO_INSURANCE', label: 'Assurance propriétaire (PNO)' },
  { value: 'WORKS', label: 'Travaux' },
  { value: 'MAINTENANCE', label: 'Entretien' },
  { value: 'AGENCY', label: 'Frais d’agence' },
  { value: 'CUSTOM', label: 'Autre dépense' },
];

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Saisie manuelle : création d'un bien, puis ajout d'un loyer ou d'une dépense
 * sur un bien existant. Aucune opération bancaire n'est déclenchée.
 */
export function PropertyForms({ properties, onChanged }: PropertyFormsProps) {
  const createProperty = useAction();
  const addCashFlow = useAction();

  const [name, setName] = useState('');
  const [kind, setKind] = useState('APARTMENT');
  const [address, setAddress] = useState('');
  const [purchasePrice, setPurchasePrice] = useState('200000');
  const [currentValue, setCurrentValue] = useState('210000');

  const [targetId, setTargetId] = useState('');
  const [direction, setDirection] = useState<'INCOME' | 'EXPENSE'>('INCOME');
  const [category, setCategory] = useState('RENT');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [recurrence, setRecurrence] = useState('MONTHLY');

  const selectedTarget = targetId === '' ? (properties[0]?.accountId ?? '') : targetId;
  const categories = direction === 'INCOME' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  const submitProperty = (): void => {
    void createProperty.run(async () => {
      await request<PropertyDto>('/api/real-estate', {
        method: 'POST',
        json: {
          name,
          kind,
          address: address === '' ? null : address,
          purchasePrice: Number.parseFloat(purchasePrice) || 0,
          currentValue: Number.parseFloat(currentValue) || 0,
        },
      });
      setName('');
      setAddress('');
      onChanged();
      return 'Bien enregistré : il apparaît dans la synthèse ci-dessus.';
    });
  };

  const submitCashFlow = (): void => {
    void addCashFlow.run(async () => {
      if (selectedTarget === '') throw new Error('Aucun bien disponible : créez d’abord un bien.');
      await request<{ readonly id: string }>(`/api/real-estate/${selectedTarget}/cashflows`, {
        method: 'POST',
        json: {
          direction,
          category,
          label: label === '' ? categories[0]?.label ?? 'Mouvement' : label,
          amount: Number.parseFloat(amount) || 0,
          currency: 'EUR',
          date,
          recurrence,
        },
      });
      setLabel('');
      setAmount('');
      onChanged();
      return direction === 'INCOME' ? 'Loyer enregistré.' : 'Dépense enregistrée.';
    });
  };

  return (
    <>
      <Card
        title="Ajouter un bien immobilier"
        subtitle="Saisie manuelle : valeur d’acquisition, valeur estimée, surface."
        className="property-form"
      >
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            submitProperty();
          }}
        >
          <label className="field">
            <span className="field-label">Nom du bien</span>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label className="field">
            <span className="field-label">Type</span>
            <select className="input" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="APARTMENT">Appartement</option>
              <option value="HOUSE">Maison</option>
              <option value="PARKING">Parking</option>
              <option value="BUILDING">Immeuble</option>
              <option value="LAND">Terrain</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Adresse</span>
            <input className="input" value={address} onChange={(event) => setAddress(event.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Prix d’achat (€)</span>
            <input className="input" type="number" min="0" value={purchasePrice} onChange={(event) => setPurchasePrice(event.target.value)} required />
          </label>
          <label className="field">
            <span className="field-label">Valeur estimée (€)</span>
            <input className="input" type="number" min="0" value={currentValue} onChange={(event) => setCurrentValue(event.target.value)} required />
          </label>
          <div className="card-actions-row">
            <button type="submit" className="btn btn-primary" disabled={createProperty.pending || name === ''}>
              {createProperty.pending ? 'Enregistrement…' : 'Ajouter le bien'}
            </button>
          </div>
        </form>
        <ActionFeedback state={createProperty} />
      </Card>

      <Card
        title="Ajouter un loyer ou une dépense"
        subtitle="Rattachez un flux récurrent au bien concerné : loyer encaissé ou charge payée."
        className="cashflow-form"
      >
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            submitCashFlow();
          }}
        >
          <label className="field">
            <span className="field-label">Bien</span>
            <select className="input" value={selectedTarget} onChange={(event) => setTargetId(event.target.value)}>
              {properties.length === 0 && <option value="">Aucun bien</option>}
              {properties.map((property) => (
                <option key={property.accountId} value={property.accountId}>
                  {property.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Nature</span>
            <select
              className="input"
              value={direction}
              onChange={(event) => {
                const next = event.target.value === 'EXPENSE' ? 'EXPENSE' : 'INCOME';
                setDirection(next);
                setCategory(next === 'INCOME' ? 'RENT' : 'CONDO_FEES');
              }}
            >
              <option value="INCOME">Loyer (encaissement)</option>
              <option value="EXPENSE">Dépense (décaissement)</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Catégorie</span>
            <select className="input" value={category} onChange={(event) => setCategory(event.target.value)}>
              {categories.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Libellé</span>
            <input className="input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={direction === 'INCOME' ? 'Loyer mensuel' : 'Charges trimestrielles'} />
          </label>
          <label className="field">
            <span className="field-label">Montant (€)</span>
            <input className="input" type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required />
          </label>
          <label className="field">
            <span className="field-label">Date</span>
            <input className="input" type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
          </label>
          <label className="field">
            <span className="field-label">Récurrence</span>
            <select className="input" value={recurrence} onChange={(event) => setRecurrence(event.target.value)}>
              <option value="MONTHLY">Mensuelle</option>
              <option value="QUARTERLY">Trimestrielle</option>
              <option value="YEARLY">Annuelle</option>
              <option value="ONE_OFF">Ponctuelle</option>
            </select>
          </label>
          <div className="card-actions-row">
            <button type="submit" className="btn btn-primary" disabled={addCashFlow.pending || amount === '' || selectedTarget === ''}>
              {addCashFlow.pending ? 'Enregistrement…' : direction === 'INCOME' ? 'Ajouter le loyer' : 'Ajouter la dépense'}
            </button>
          </div>
        </form>
        <ActionFeedback state={addCashFlow} />
      </Card>
    </>
  );
}
