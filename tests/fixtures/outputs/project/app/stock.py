"""Stock levels for a small warehouse."""
def reorder_level(item):
    return item.minimum * 2


def on_hand(item):
    return item.counted - item.reserved
