CREATE TRIGGER measurement_subject_classification_chronology_guard
BEFORE UPDATE OF classification, classification_basis, classification_attested_at
ON measurement_subjects
FOR EACH ROW
WHEN NEW.classification_attested_at <= OLD.classification_attested_at
BEGIN
  SELECT RAISE(ABORT, 'measurement classification chronology conflict');
END;
