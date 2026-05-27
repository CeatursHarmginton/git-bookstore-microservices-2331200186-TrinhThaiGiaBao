import express from 'express';
import axios from 'axios';
import db from './db.js';
import { connectToBroker, publishMessage } from './broker.js';

const app = express();
app.use(express.json());

// RabbitMQ
connectToBroker().catch(err => console.error('Broker init error', err));

// Create order
async function createOrder(req, res) {
  try {
    const productId = Number(req.body.productId);
    const quantity = Number(req.body.quantity);
    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({ error: 'productId is required' });
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'quantity must be positive' });
    }

    let product;
    try {
      const productUrl = process.env.PRODUCT_SERVICE_URL || 'http://product-service:8002';
      const response = await axios.get(`${productUrl}/${productId}`, { timeout: 5000 });
      product = response.data;
    } catch (err) {
      if (err.response?.status === 404) {
        return res.status(404).json({ error: 'Product not found' });
      }
      console.error('Product service error:', err.message);
      return res.status(503).json({ error: 'Product service unavailable' });
    }

    if (Number(product.stock) < quantity) {
      return res.status(400).json({ error: 'Not enough stock' });
    }

    const r = await db.query(
      'INSERT INTO orders (product_id, quantity, status) VALUES ($1,$2,$3) RETURNING *',
      [productId, quantity, 'PENDING']
    );
    const order = r.rows[0];
    const event = {
      event: 'ORDER_CREATED',
      orderId: order.id,
      productId,
      product: {
        id: product.id,
        title: product.title,
        author: product.author,
        price: product.price
      },
      quantity,
      status: order.status,
      createdAt: order.created_at
    };

    await publishMessage('order.created', event);
    console.log('Published order.created event:', event);
    res.status(201).json({ message: 'Order created', order, event });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

app.post('/', createOrder);
app.post('/orders', createOrder);

// List orders
async function listOrders(_req, res) {
  const r = await db.query('SELECT * FROM orders ORDER BY id DESC');
  res.json(r.rows);
}
app.get('/', listOrders);
app.get('/orders', listOrders);

// Get order by id
async function getOrderById(req, res) {
  const id = Number(req.params.id);
  const r = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  res.json(r.rows[0]);
}
app.get('/:id', getOrderById);
app.get('/orders/:id', getOrderById);

const PORT = 8003;
app.listen(PORT, () => console.log(`Order Service running on ${PORT}`));
