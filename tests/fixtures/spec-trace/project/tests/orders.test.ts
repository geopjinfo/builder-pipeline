import { placeOrder } from '../src/orders';
import { emptyOrder } from './helpers';

test('REQ-001: an order with no lines is refused', () => {
  expect(() => placeOrder(emptyOrder())).toThrow('ORDER_EMPTY');
});
