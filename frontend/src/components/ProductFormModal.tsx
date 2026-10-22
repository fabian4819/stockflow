import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ApiError, api, errorMessage } from '../api/client'
import type { Product } from '../api/types'
import { validateProductForm, type ProductFormErrors, type ProductFormValues } from '../lib/validate'
import { Alert, FieldError, Modal } from './ui'

interface Props {
  product?: Product // edit when set, create otherwise
  onClose: () => void
  onDone: (message: string) => void
}

export function ProductFormModal({ product, onClose, onDone }: Props) {
  const queryClient = useQueryClient()
  const isEdit = product !== undefined
  const [values, setValues] = useState<ProductFormValues>({
    sku: product?.sku ?? '',
    name: product?.name ?? '',
    price: product ? String(product.price) : '',
  })
  const [isActive, setIsActive] = useState(product?.is_active ?? true)
  const [errors, setErrors] = useState<ProductFormErrors>({})

  const mutation = useMutation({
    mutationFn: () => {
      const body = { name: values.name.trim(), price: Number(values.price.trim()), is_active: isActive }
      return product ? api.updateProduct(product.id, body) : api.createProduct({ ...body, sku: values.sku.trim() })
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries()
      onDone(`${saved.sku} ${isEdit ? 'updated' : 'created'}`)
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fields)
    },
  })

  function set<K extends keyof ProductFormValues>(key: K, value: string) {
    setValues((v) => ({ ...v, [key]: value }))
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const found = validateProductForm(values, !isEdit)
    setErrors(found)
    if (Object.keys(found).length === 0) mutation.mutate()
  }

  const generalError =
    mutation.error && !(mutation.error instanceof ApiError && Object.keys(mutation.error.fields).length > 0)
      ? errorMessage(mutation.error)
      : undefined

  return (
    <Modal title={product ? `Edit ${product.sku}` : 'New product'} onClose={onClose}>
      <form onSubmit={submit} noValidate className="form">
        <label className="label" htmlFor="product-sku">
          SKU
        </label>
        <input
          id="product-sku"
          className={`input ${errors.sku ? 'invalid' : ''}`}
          value={values.sku}
          disabled={isEdit}
          autoFocus={!isEdit}
          onChange={(e) => set('sku', e.target.value)}
        />
        {isEdit ? <p className="hint">SKU cannot be changed once created.</p> : <FieldError message={errors.sku} />}

        <label className="label" htmlFor="product-name">
          Name
        </label>
        <input
          id="product-name"
          className={`input ${errors.name ? 'invalid' : ''}`}
          value={values.name}
          autoFocus={isEdit}
          onChange={(e) => set('name', e.target.value)}
        />
        <FieldError message={errors.name} />

        <label className="label" htmlFor="product-price">
          Price (Rp)
        </label>
        <input
          id="product-price"
          className={`input ${errors.price ? 'invalid' : ''}`}
          inputMode="numeric"
          value={values.price}
          onChange={(e) => set('price', e.target.value)}
        />
        <FieldError message={errors.price} />

        <label className="checkbox">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active (can be sold)
        </label>

        {!isEdit && <p className="hint">New products start with 0 stock. Use “Adjust stock” to receive goods.</p>}
        {generalError && <Alert>{generalError}</Alert>}

        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
