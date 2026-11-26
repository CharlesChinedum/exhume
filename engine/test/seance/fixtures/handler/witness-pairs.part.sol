        // HAND-WRITTEN FIXTURE: expected generator output for `// @@WITNESS_PAIRS@@` (token fixture).
        // Witness1: occurs on the unmodified port. Witness2: never occurs on it.
        if (k == 1) return ("batchTransfer", Classifier.Class.Exorcised);
        if (k == 2) return ("transfer", Classifier.Class.PortBug);
