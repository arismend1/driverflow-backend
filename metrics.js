const counters = new Map();
const timers = new Map();

// Helper to get key from name + labels
function getKey(name, labels = {}) {
    const sortedKeys = Object.keys(labels).sort();
    const labelStr = sortedKeys.map(k => `${k}=${labels[k]}`).join(',');
    return labelStr ? `${name}{${labelStr}}` : name;
}

const metrics = {
    // Counters
    inc: (name, labels = {}) => {
        const key = getKey(name, labels);
        const current = counters.get(key) || 0;
        counters.set(key, current + 1);
    },

    // Timers (Rolling Average Validation simplified to Last + Count + Sum for MVP)
    observe: (name, value, labels = {}) => {
        const key = getKey(name, labels);
        const current = timers.get(key) || { count: 0, sum: 0, min: value, max: value, last: value };

        current.count++;
        current.sum += value;
        current.min = Math.min(current.min, value);
        current.max = Math.max(current.max, value);
        current.last = value;

        timers.set(key, current);
    },

    // Output JSON
    getSnapshot: () => {
        const data = {
            counters: {},
            timers: {}
        };
        for (const [k, v] of counters) data.counters[k] = v;
        for (const [k, v] of timers) {
            data.timers[k] = {
                ...v,
                avg: v.count > 0 ? (v.sum / v.count).toFixed(2) : 0
            };
        }
        return data;
    }
};

module.exports = metrics;
