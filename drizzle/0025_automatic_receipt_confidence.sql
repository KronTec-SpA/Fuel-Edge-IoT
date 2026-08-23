UPDATE `fuel_movements` SET `confidence`=ROUND(
  CASE
    WHEN COALESCE(`original_liters`,`liters`) < 100
      THEN MIN(0.79,MAX(0.25,COALESCE(`original_liters`,`liters`)/100.0))
    ELSE 0.87 + ((COALESCE(`original_liters`,`liters`)-100)/20.0)*0.11
  END,3)
  WHERE `movement_type`='receipt' AND `detected_automatically`=1
    AND `review_status`='pending' AND COALESCE(`original_liters`,`liters`) < 120;
