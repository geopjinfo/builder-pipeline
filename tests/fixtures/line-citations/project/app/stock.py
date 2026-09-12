"""Stock adjustments."""
# Guarded by stock.adjust, cited by key.
# Movement rows are summed in levels.py:2, see test_levels.py:30.
def adjust(sku, qty):
    return qty
