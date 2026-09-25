import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { missingFields, parseLocally, requestsPositionLifecycle } from './intent.mjs'

test('vague protection intent asks for missing quantity', () => {
  const intent = parseLocally('Protect my SOL next week')
  assert.equal(intent.kind, 'put')
  assert.equal(intent.expiryDays, 7)
  assert.deepEqual(missingFields(intent), ['quantity in SOL'])
})

test('follow-up fills missing details without losing previous intent', () => {
  const intent = parseLocally('0.1 SOL', parseLocally('Buy a put next week'))
  assert.equal(intent.quantitySol, 0.1)
  assert.equal(intent.kind, 'put')
  assert.deepEqual(missingFields(intent), [])
})

test('budget is not mistaken for protected size', () => {
  const intent = parseLocally('Spend at most 0.1 SOL to protect 5 SOL next week')
  assert.equal(intent.quantitySol, 5)
  assert.equal(intent.maxPremiumSol, 0.1)
})

test('USD spend cap stays separate from strike target', () => {
  const intent = parseLocally('Buy a put below $110 to protect 0.1 SOL, budget $1')
  assert.equal(intent.targetStrikeUsd, 110)
  assert.equal(intent.quantitySol, 0.1)
  assert.equal(intent.maxPremiumUsd, 1)
})

test('closing a held put cannot become a new short put', () => {
  assert.equal(requestsPositionLifecycle('sell my put'), true)
  assert.equal(requestsPositionLifecycle('sell a 0.1 SOL put'), false)
})
