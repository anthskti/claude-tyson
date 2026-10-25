def event_line(event):
    """Host-session milliseconds; IMU sample time is callback-receipt aligned."""
    classification = event.get('punchType', 'pose')
    sample = event['sampleMs']
    detected = event.get('detectedMs', sample)
    model = f"  model_p={event['modelProbability']:.3f}" if 'modelProbability' in event else ''
    return f"{sample:>8.0f} ms  {event['type']}  class={classification}  detected={detected:.0f} ms"+model
