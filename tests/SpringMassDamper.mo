model SpringMassDamper
  Real x(start = 1.0);
  Real v(start = 0.0);
  parameter Real m = 1.0;
  parameter Real k = 10.0;
  parameter Real d = 0.5;
equation
  v = der(x);
  m * der(v) = -k * x - d * v;
end SpringMassDamper;
