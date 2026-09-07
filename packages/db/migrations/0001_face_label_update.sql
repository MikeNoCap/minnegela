-- Confirming a face in the review queue must flip event visibility in the same transaction (§18.3),
-- so the API role may update identity columns on faces it can see. Embeddings stay in ml.*.
create policy faces_update on faces for update
  using (exists (select 1 from blobs b where b.id = faces.blob_id));
